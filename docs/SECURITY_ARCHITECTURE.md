# Aivota / CliniAACian — Security Architecture

This document describes how the platform handles sensitive data — identification, classification, storage, encryption, access control, audit, retention, sub-processors, breach response, and vulnerability management. It is **regime-neutral** (HIPAA, GDPR, FERPA, IL Privacy Protection Law, IL MoE, US Section 508, etc.) and reads through the `shared/regime/` registry for defaults that vary per jurisdiction.

For AWS infrastructure detail (VPC, IAM, KMS, ECS vs Lambda, WAF, CloudTrail) see [`INFRASTRUCTURE.md`](INFRASTRUCTURE.md). This document focuses on the **application and data layer**.

> **Audience:** internal security review, regulator reviewers (Israel MoE Sapakim, Experis pen-test team, EU/US data-protection authorities), and incoming sub-processors.

## 0. Versioning

| Field | Value |
|---|---|
| Last updated | 2026-09-10 (authorization audit — §5.5.1, §5.8) |
| Document owner | Aivota Engineering |
| Review cadence | Quarterly, plus before any material processing change |
| Source of truth | This file lives in the application repo and is updated alongside the code that implements it. |

## 1. Scope and Data Classification

The platform handles four classes of data. Tables are split across `shared/schema.ts` (public/operational) and `shared/schema-private.ts` (PHI/PII/student data).

### 1.1 Classes

| Class | Description | Location | Access |
|---|---|---|---|
| **PHI / Sensitive student data** | Medical records, behavioral observations, biometric data, communication transcripts, AAC session memory, photos | `schema-private.ts` (most tables); S3 uploads bucket | Application-only via `accessCtx`; never logged in queries |
| **PII** | User profile (name, email, phone), guardian contact, institute member roster, login telemetry | `schema-private.ts` (`users`, `studentContacts`, etc.) | Application-only; redaction layer for IDs |
| **Operational** | Institutes, licenses, identity providers, voices catalog, system settings, billing/subscription, public symbols | `schema.ts` | Application + admin |
| **Audit** | `activityLogs` (read-access events, share lifecycle), AWS CloudTrail (API calls), VPC Flow Logs | `schema-private.ts:activityLogs` + AWS-managed | Read-only; KMS-encrypted; retention per regime |

### 1.2 Sensitive table inventory

The PHI/PII tables in `shared/schema-private.ts` (**74** `pgTable` declarations as
of 2026-08-26) include the following. The list below is illustrative, not
exhaustive — tables added since it was written (among them `aacSessionPlans`,
`studentDevices`, `studentCaretakerPins`, `sessionDebugLogs`, `sessionCostEvents`,
`aacUtteranceEvents`, `callSessions`, `callParticipants`, `photos`,
`photoAssignments`, `captionProjects`, `externalConnections`) are PHI/PII on the
same terms:

- **Students & care team:** `students`, `aacSettings`, `biometricData`, `studentContacts`, `userStudents`, `instituteStudents`, `studentClassrooms`
- **Health & education:** `medicalRecords`, `functionalReports`, `educationalReports`, `programs`, `profileDomains`, `baselineMeasurements`, `assessmentSources`, `goals`, `objectives`, `userGoals`, `userObjectives`, `services`, `serviceGoals`, `serviceUsers`, `accommodations`, `progressReports`, `goalProgressEntries`, `dataPoints`, `incidents`, `transitionPlans`, `transitionGoals`, `programContacts`, `meetings`
- **Consent & verification:** `consentForms`, `studentConsentRecords`, `consentInvitations`, `phoneOtpCodes`
- **AI & memory:** `chatSessions`, `deepAnalyses`, `persons`, `personChatRooms`, `personChatRoomParticipants`, `personChats`, `personChatPushTokens`, `boards` (row-scoped — see §1.2.1), `customApps`, `customAppAssignments`
- **Files & integrations:** `dropboxConnections`, `dropboxBackups`
- **Sharing & invites:** `inviteCodes`, `inviteCodeRedemptions`, `studentShareInvites`, `objectShares`, `standingShares`, `studentSymbolAssociations`, `packageAssignments`
- **Auth & ops:** `users`, `passwordResetTokens`, `mfaRecoveryTokens`, `activityLogs`

The schema split is enforced by file convention with one deliberate exception (§1.2.1). Private-schema tables (`schema-private.ts`) require a typed `accessCtx` for reads.

**Known exceptions to "the public schema carries no PHI".** Four tables in
`shared/schema.ts` do carry PII, and breach scoping must account for them:
`licenses.inviteDefaults` (JSONB holding `governmentIdNumber`, phone and names),
`userExternalIdentities.claims` (the raw IdP profile, which for IL MoE Sapakim
carries `nationalIdNumber`), `calendarEventAttendees` (links a named child to a
therapy event's title/description) and `contactInquiries`. Moving them, or
encrypting the carrier columns, is **not done — open**.

### 1.2.1 Row-scoped classification: `boards`

`boards` is the one private-schema table whose rows are **not uniformly PHI**. It holds two kinds
of row, distinguished by a `scope` column:

| `scope` | What it is | Classification | Governance |
|---|---|---|---|
| `student` (default) | A communication board authored for a specific student, or for its author's own use | **PHI** | `studentId` / `userId` as before; `irData` routed through external storage |
| `package` | Shareable content owned by an institute and distributed through `packages` | **Operational** | `packageAccess` resolver; excluded from external storage |

This is enforced structurally, not by convention:

- **A database CHECK constraint** — `boards_package_scope_has_no_student` — asserts that a
  `scope='package'` row has `student_id IS NULL AND institute_id IS NOT NULL`. A package board
  therefore *cannot* be student-linked; the invariant is held by Postgres, not by application code.
- **Content validation at the boundary.** Material identifying a student (references to their
  contacts' faces) is refused entry to a package at every visibility. Images of identifiable people
  — e.g. staff portraits — are permitted in institute-visible packages and refused in public ones.
  Implemented in `shared/package-validation.ts` + `server/services/packages/packageContent.ts`.
- **Ownership resolution short-circuits** for package rows
  (`server/external-storage/registry.ts`), so package content is never written to an
  institute-scoped external backend.
- **Reads funnel through one resolver.** `server/services/packages/packageAccess.ts` answers every
  "who may do what" question for package content; student-scoped rows keep the existing
  `accessCtx` path.

Publication beyond the owning institute additionally requires an explicit human attestation that
the package contains no images of identifiable people, recorded on the package row and audited as
`package_published` (§6.1). An LLM agent cannot perform this step. Public listing further requires
platform-admin review.

**Breach scoping.** Because the split is a column rather than a heuristic, "which rows of `boards`
were PHI" is a query (`WHERE scope = 'student'`), not a forensic exercise. See
[`planning-docs/aac-packages-plan.md`](../planning-docs/aac-packages-plan.md) for the full model.

### 1.3 Identification numbers & redaction

Israeli Teudat-Zehut (national ID) is treated as write-only **on the AI/memory-schema
path**: `server/services/memory-schema/institute-memory-schema.ts` replaces the value
with `[REDACTED]` on read and ignores that placeholder on write, so no ID number
reaches a prompt. The pattern is documented at [`memory/project_id_number_redaction.md`].

Two limits worth stating plainly:

- This is an **API-response mask, not encryption**. `instituteStudents.idNumber`
  and `studentContacts.governmentIdNumber` are stored in plaintext, as are the
  biometric identifiers (`biometricData.faceEmbedding`, `voiceEmbedding`,
  `physicalDescription`). Applying the §4.3 field encryption to them is **not
  done — open** (§164.514(b)(2)(xvi)).
- The mask is **not applied at the REST layer**. The institute-enrollment
  endpoints in `server/controllers/instituteController.ts` return the raw
  `idNumber` to an authorized clinician. No path from there reaches a prompt, but
  the doc should not be read as claiming a database-level guarantee.

## 2. Data Flow Diagrams

Each flow represents one end-to-end path with the components involved and the data that moves between them.

### 2.1 Authentication / SSO

```
Browser ──HTTPS──> CloudFront / ALB ──> Express (ECS Fargate)
                                          │
                                          ├──> sessions (Postgres) — CSRF, MFA challenge, identity link state
                                          ├──> users (passwordHash + mfaSecret encrypted)
                                          ├──> identityProviders (OIDC | OAuth2 | SAML)
                                          │       │
                                          │       └─Redirect─> External IdP ──Callback──> ACS / OIDC callback
                                          │       │                                            │
                                          │       └────────────────────────────────────────────┘
                                          │                applyClaimMapping → CanonicalProfile
                                          │
                                          └──> userExternalIdentities (link)
```

- **Files:** `server/userAuth.ts`, `server/services/identityService.ts`, `server/controllers/identityController.ts`, `server/services/saml-helpers.ts`, `server/services/identity-claim-mapping.ts`.
- **CSRF:** OIDC `state` and SAML `RelayState` are random 32-byte tokens stored in the express session and checked on callback.
- **MFA:** TOTP via `speakeasy`; `mfaSecret` AES-256-GCM encrypted at the application layer; recovery codes hashed (see §5.3). MFA can be enforced per-institute; bypass requires admin support session.
- **External IdP claims:** stored in `user_external_identities.claims` JSONB; canonical fields (`externalId`, `email`, `givenName`, `familyName`, `nationalIdNumber`, `userType`, `instituteCode`) extracted via `applyClaimMapping`. Per-provider mappings live in `identity_providers.claim_mappings`.

### 2.2 AAC live session (student-facing)

```
AAC client (browser/Electron/iPad)
  │ WS upgrade — authenticated at the boundary (session cookie, or WS ticket on iPad)
  ▼
Express WS handler ── WebSocket ──> LiveProvider (Gemini Live | OpenAI Realtime)
  │                                                │
  │  Mic PCM frames (HTTPS/WS)                    │  PCM audio output
  │  Camera frames (sendRealtimeInput)            │
  │  Tool calls (function calling)                │
  │                                                │
  └── pendingMessages buffer ──> Monitor Agent (HTTP LLM)
                                       │
                                       ├──> chatSessions (memory store)
                                       └──> aac-memory-schema ops (incidents, notes, etc.)
                                              │
                                              └──> private schema with accessCtx
```

- **Upgrade authentication:** `/ws/live` authenticates before the socket is accepted (`server/services/realtime/ws-auth.ts`); an unauthenticated upgrade gets `401` and the socket is destroyed. Without this, a harvested student UUID would be enough to open a session and exfiltrate PHI through the live model.
- **Origin check on upgrade:** the HTTP `upgrade` event bypasses Express, so the global CSRF middleware never sees it. `authenticateUpgrade` therefore checks `req.headers.origin` against the allowlist (`isAllowedUpgradeOrigin`, `server/middleware/security.ts`) **before any credential is looked at**; a present-but-foreign Origin is refused, an absent one (native shells) is allowed. Without it, any web page a signed-in clinician visited could open `wss://…/ws/live` with their cookies — the session cookie is `SameSite=None` in production — and stream PHI back.
- **Topic subscription is deny-by-default:** the realtime server's `subscribe` command runs through a `canSubscribe` hook rather than trusting the client-supplied topic string (`server/services/realtime/realtime-server.ts`). No client legitimately sends `subscribe` — the server subscribes sockets itself.
- **WS ticket (iPad only):** the Capacitor shell keeps its session cookie in the native cookie store, which a WKWebView-issued handshake cannot reach, so it presents a ticket minted by `POST /api/aac/live/ws-ticket` (itself session-authenticated). Tickets are HMAC-SHA256 signed with a key derived from `SESSION_SECRET`, TTL 60 s, single-use, and carry only a user id — no PHI, no session id, and not exchangeable back into a session. The user record is still loaded on redemption, so a deleted or disabled account cannot connect. **Single-use holds across tasks:** the replay set is the Postgres `ws_ticket_nonces` table (`server/services/realtime/ws-ticket-store-pg.ts`), where an atomic `INSERT … ON CONFLICT DO NOTHING RETURNING` gives exactly one of the 2–10 ECS tasks the row; the in-memory `Map` in `ws-ticket.ts` is now the test-only store. Rows are pruned opportunistically on redeem. See `server/services/realtime/ws-ticket.ts`.
- **Provider selection** at session init from `system_settings` `aac_chat` LLM config; provider rows can rotate without code changes.
- **No raw audio at rest:** PCM frames and camera frames flow through the live relay only; neither is persisted server-side. **Transcripts are persisted verbatim** in `chatSessions`/memory schema — there is no redaction step on that path, and bystander speech heard near the device is written to the log too (`[HEARD NEARBY — speaker unknown]`). An earlier version of this document claimed redaction; that was never implemented. Redaction (and a consent notion for non-student speakers) is **open**.
- **Monitor agent:** read-only on PHI; it can write to low-security memory categories (notes, observations) but not to medical records or goals. Gating is in `server/services/memory-schema/aac-memory-schema.ts`. **It no longer has any report field at all** (2026-09-14): `getAACMemoryFields` returns none, and no live agent reads a diagnosis. Clinical reports reach an AAC session only as the **report digest** (`server/services/aac/report-digest.ts`) — a machine-generated distillation of the newest FINAL medical/functional/educational reports into operational facts (what the AAC must do, avoid or expect), carrying no diagnosis label. It is stored machine-owned in `aac_settings.report_digest`, regenerated when the source reports change, cleared when `allowReadReports` goes off, and every generation writes a `view` audit row on route `aac.report-digest`.
- **Tool responses** are delivered via `sendContextInjection` (Gemini) to avoid duplicate generation; documented at [`memory/duplication_root_cause.md`].

### 2.3 Sharing — cross-institute student access

```
Source institute admin                Guardian                Target institute admin
        │                                 │                            │
        ▼                                 ▼                            ▼
  CreateShareInvite              Phone OTP / SSO              Redeem invite code
  (selects bundle)               co-sign on minor             (with accessCtx)
        │                            (idv-methods.ts)              │
        ▼                                                            ▼
  studentShareInvites ─pending_bundle JSON─> studentConsentRecords ─> objectShares + standingShares
        │                                                            │
        └─lifecycle events─> activityLogs (created/accepted/revoked) │
                                                                     ▼
                                              Cross-institute reads via accessCtx
                                                       │
                                                       └──> recordShareDerivedView
                                                              (activityLogs.eventType="view")
```

- **Files:** `server/services/sharing/`, `server/services/sharing/audit.ts`, `server/services/sharing/visibility.ts`.
- **Pending-bundle pattern:** `studentShareInvites.pending_bundle` JSONB carries the share specification before guardian co-sign; rows in `objectShares`/`standingShares` only materialize after redemption. This avoids exposing intent to the target before the human checks complete. See [`memory/project_share_invite_bundle.md`].
- **Audit:** `recordShareDerivedView` fires `view` events ONLY for cross-institute reads. Owned reads are not logged. See [`memory/project_share_audit_logging.md`].
- **Identity verification:** consent operations gate on `IdvMethod` (in `shared/legal/idv-methods.ts`) chosen per regime — `verified_phone_otp` for sensitive medical (IL Privacy Protection Authority, Feb-2026), `in_person_clinician_attested` when the guardian is at the clinic desk (§2.4), `gov_sso` when SSO is configured, `signed_form_upload` as fallback. The registry is the authority on which of these a regime accepts; call sites never hardcode the list.

### 2.4 Consent and minor-protection

```
Clinician initiates onboarding ──> SendConsentRequestDialog
        │                                   │
        ▼                                   ▼
  consentInvitations             SMS (AWS SNS) or Email (AWS SES) ──> Guardian
        │                                                            │
        │                                       phone_otp_codes      │
        │                                       <─verify──────────── │
        ▼                                                            ▼
  studentConsentRecords ── stamped recipients (recipients.ts) + IDV methods + minor-protection regime
```

- **Files:** `server/services/consent/`, `shared/legal/`.
- **What the consent WRITE-gate covers (widened 2026-09-10).** `CONSENT_GATE_ENABLED`
  + the 90-day legacy grace window; one helper, `requireConsentForMemoryWrite` /
  `requireActiveConsent` in `server/services/consent/consentGate.ts`. Covered:
  report / program / incident memory writes and their finalize endpoints; AAC
  live-session start; cross-institute share-invite create; **and, since
  2026-09-10, the AI's record OF THE CHILD** — `Student_People`,
  `Student_Interests`, `Student_CommunicationStyle`, `Student_Preferences`,
  `Student_Notes`, the column-backed `Student_CommunicationProfile`,
  `Relationship_Notes`, and the AI's door into `aac_settings`
  (`Context_AACPrompt` / `Context_AACAutoPrompt` / `Context_AACSettings`, both
  through `writeAACSettings` and through `institute-memory-schema`'s
  `aacSettingsOps`). Until then those were guarded by **prompt text only** — a
  `WAITING FOR CONSENT` block saying "No `Student_*` memory writes" — and on
  2026-09-08 the assistant walked straight through it and wrote a communication
  profile for a consent-blocked child. Prompt text is not an enforcement
  mechanism. **Two enforcement points, both required:** the memory-schema op
  (what the AI reads — an AI-legible `ConsentGateError`) and
  `sessionService.onUpdateMemoryValues` (what stops the bytes), because those
  schema ops do not write rows and `memory-db-bridge` does not roll a failed
  op's value out of memory. **Reads are never gated**, and `student_contacts`
  writes, consent-record creation, draft reports/programs and the non-AI
  writers of `aac_settings` stay open by design — see
  `docs/student-consent-implementation.md` §7.2/§7.4 for the full map and the
  reasoning.
- **One gate for the student-scoped reads (2026-09-09).** `/active`, `/history`,
  `/authority` and `/invitations` all answer through a single
  `assertStudentAccess` in `server/controllers/consentController.ts`: system
  admin passes, everyone else must share an ACTIVE institute with the student.
  ⚠️ **Renamed and relocated 2026-09-10** — the rules below are unchanged, but
  they now live in `server/services/access/` and read
  `assertSharesInstituteWithStudent` / `sharesInstituteWithStudent` /
  `administersStudentInstitute`; §5.4.2 is the map. Everything this section says
  about WHO is admitted still holds.
  It is one function because it was four, and all four were wrong in the same
  way — `instituteRepository.getInstitutesByStudentId` returns
  `{ institute, enrollment }` rows while `getInstitutesByUserId` returns bare
  `Institute[]`, and each copy compared `row.id` (`undefined`) against the
  user's institute ids. `Set.has(undefined)` is false for everyone, so the gate
  denied every non-system-admin — including the patient's own clinician — while
  reading as correct. An `(m: any)` cast hid the mismatch from `tsc`; the helper
  is deliberately cast-free so the compiler catches a recurrence.
  The general rule this established — institute-derived authorization is derived
  from the STUDENT's enrolments, never from an institute id the caller supplied —
  is stated in **§5.5.1**, together with who may link a user to a student. The
  2026-09-10 audit found `POST /api/students/:id/link` failing it as a live
  privilege escalation.
  Two further consequences of the same line, both now closed and pinned by
  `server/tests/integration/consent-api.test.ts`:
  - `GET .../active` had **no permission check at all** — any authenticated
    user could read any student's consent record.
  - `PUT .../authority` was **open to any authenticated user**, not closed:
    the admin path passed `undefined` to `isUserAdminOfInstitute`, whose first
    line is `if (getActiveSupportInstituteId() === instituteId) return true`
    and which returns `undefined` outside a support session, so
    `undefined === undefined` granted institute-admin rights to the caller.
- **`GET .../wizard-context` — the parent path modelled explicitly (2026-09-10,
  CLOSED).** This endpoint returns the student's name, birth date, country and
  active consent record, and until this date its DEFAULT path checked only that
  a session existed — its whole permission logic was `if (!userId) 401`, so
  every authenticated account on the platform could read every student's. It was
  deliberately excluded from the sweep above because gating it on
  `assertStudentAccess` alone would have refused legitimate signers in
  production. It is now gated on `assertWizardContextAccess`
  (`consentController.ts`), which admits a caller when ANY of three holds:
  - they share an ACTIVE institute with the student — the same
    `userSharesInstituteWithStudent` the sweep's gate is built on, system admins
    included; **or**
  - a `student_contacts` row for that student carries their `linked_user_id`;
    **or**
  - an ACTIVE `user_students` link ties them to the student
    (`studentRepository.userHasAccessToStudent`).

  **Why not institute overlap alone.** The rule is not a guess at who the
  parents are — it is the union of the predicates `POST .../sign` ALREADY
  enforces, and `/sign` admits exactly two callers, neither of them "institute
  member": guardian sign requires `contact.linked_user_id === caller`
  (`contact_not_owned_by_caller` otherwise) and self sign requires an active
  `user_students` link. A family-account student may be enrolled in no institute
  at all. A read gate narrower than the write it prepares would hand a
  legitimate signer a 403 on the consent they are entitled to sign, which is why
  this endpoint was left open rather than gated wrong. There is no fourth
  predicate and no second copy of any of the three; the contact half reuses the
  row the handler loads for the response body anyway.

  **What the constraint was NOT about.** The magic-link guardian — the parent
  with no account at all — never reaches this endpoint. `ConsentSignPage`
  renders the wizard in token mode, which resolves context through the public
  `POST /api/consent/invitations/redeem` and signs through `/invitations/sign`.
  The "may hold no institute membership" concern is real but applies to the
  SESSION-authed parent (the family-account owner, and a linked co-guardian who
  is not a member of the clinic), not the token-authed one.

  **Enumeration-safe ordering.** The permission check runs BEFORE the student
  row is read, so an unpermitted caller gets the same `403 permission_denied`
  for a real student id and an invented one; the 404 is reachable only by a
  caller who already passed the gate. The 401/403 bodies are byte-identical to
  `assertStudentAccess`'s, so a refusal does not even say which gate refused.

  Its `?contactId=` variant (added 2026-09-09 for the in-person attest path)
  remains on `assertStudentAccess` — institute overlap, unchanged and NOT
  widened by the three-way rule: naming another person's `studentContacts` row
  is not something a bare session may do, so a linked guardian who passes the
  default path is still refused when they name someone else's contact. Pinned in
  both directions by `server/tests/integration/consent-api.test.ts`.
- **Every PUBLIC consent route is rate-limited (2026-09-10).** The
  unauthenticated, token-authed surface is
  `/api/consent/invitations/{redeem,sign,request-otp,verify-otp,verify-id}` plus
  the six `/api/consent/withdraw/*` routes. `redeem`, `sign` and all six
  withdrawal routes carried `authRateLimiter` (10 req/min per IP, per-IP fixed
  window); the three second-factor legs of the *signing* flow shipped without
  one and now carry it too.
  State plainly what it does and does not do. It is **not** what bounds the
  guessing: `verify-id` checks the last 4 digits of a child's institute ID (a
  10,000-value space) and is capped at 5 wrong attempts by
  `CHILD_ID_MAX_VERIFY_ATTEMPTS`, after which the invitation locks until a
  clinician re-issues; `verify-otp` is capped at 5 wrong codes per OTP; and
  `request-otp` is capped at 5 sends per 10 minutes per (purpose, invitation,
  phone) in `phoneOtpService`, with the destination read from the invitation's
  contact row and **never** from the request — so it was not the uncapped SMS
  amplifier an earlier note called it. What the limiter adds is the layer
  *above* all of those: every one of those caps is keyed to a RESOLVED
  invitation and is therefore blind to a request bearing a code that does not
  exist, and the invitation code is 12 chars of a 31-symbol alphabet (~59 bits),
  so junk-code probing is not a credential threat but *is* an unmetered
  sha256-plus-indexed-select per request from an unauthenticated caller. The
  per-IP limiter is the only control in front of that, and in front of the cost
  of any cap that lives below it. 10/min is well above a real guardian
  mistyping a code — they reach the 5-attempt application lock long before the
  limiter — and the window is 60 s, so a tripped limiter clears itself while the
  parent is still on the page. Wiring is pinned at the source level by
  `server/tests/consent-route-guards.test.ts` (behavioural testing is not
  possible: `authRateLimiter` self-skips under `NODE_ENV=test`), including a
  catch-all that fails on any `/api/consent/*` route carrying neither
  `requireAuth` nor `authRateLimiter`.
- **The consent WRITES that are institute-scoped (2026-09-09).** There are
  exactly two, they share ONE predicate, and both are narrower than "any
  institute member may touch consent". (A THIRD consent write exists and is
  neither institute-scoped nor session-authed at all — the public withdrawal
  confirm, 2026-09-10, documented further below.) `POST
  /api/consent/students/:studentId/attest-in-person` creates a clinician-attested
  record (below), and `POST /api/consent/:consentId/revoke` withdraws **a record
  of that kind and no other** (further below). Everything else in this section
  is about reads.
  `POST /api/consent/students/:studentId/attest-in-person` — the clinic-desk
  path: the guardian is physically present, the clinician inspects their
  identification, and the clinician records the consent from their own
  authenticated session (`in_person_clinician_attested`, which
  `shared/legal/idv-methods.ts` marks `providesBothLegs`). This is a legally
  binding write, so its rules are spelled out:
  - **Permission:** `attestPermissionFor` in `consentController.ts` — the
    institute-overlap check of `assertStudentAccess`, i.e. ANY active member of
    an institute the student is enrolled in, not institute admin. The treating
    clinician sitting with the guardian at intake is usually not the admin, so
    an admin gate would make the path unusable in the situation it exists for.
    Reversible in one line: `ATTEST_REQUIRES_INSTITUTE_ADMIN` in
    `consentController.ts`. Accountability is the audit trail (below), not the
    role gate — the attester is identified either way.
  - **The IDV method is server-owned.** Forced from a module constant; the
    endpoint's zod schema has no key for it or for `nonRepudiationMethod` /
    `isSensitive`, so a client-supplied value is stripped rather than honoured.
    This is not cosmetic: methods are not interchangeable across regimes
    (`gov_sso` is accepted for `us_coppa`, this one is not), so a client that
    could name its own method could claim a regime it did not earn. Pinned by
    `server/tests/integration/consent-attest-in-person.test.ts`.
  - **US under-13 is refused.** `in_person_clinician_attested` is not one of
    COPPA's enumerated verifiable-parental-consent methods, so the controller's
    pre-flight through `checkIdvAcceptability` returns 422 `idv_not_acceptable`
    with `details.regime = 'us_coppa'`. The pre-flight exists because
    `consentService.signConsent` checks the notice (step 5) BEFORE IDV (step 9)
    and notices exist only for IL — without it the refusal would surface as
    `notice_not_found` and the legal rule would never be reached. The rule is
    not duplicated: the same adapter is called, so adding a country stays data.
  - **`/sign` is unchanged.** Its "only the contact's linked user may sign" rule
    is correct for the parent flow and is pinned against regression in the same
    suite. The attest path is a different endpoint, not a relaxation.
  - **Evidence + audit:** the attesting clinician's user id is stored as
    `identity_verification_evidence.attestingClinicianUserId` (queryable;
    `studentConsentRecordRepository.listAttestedByUser` is the named query), and
    the write emits TWO activity rows — `consent_signed` with
    `details.identityVerificationMethod`, and `guardian_id_verified` on the
    `student_contact` naming the attester. See §6.1.
  - **Minimisation:** the government-ID number is written to the contact row and
    deliberately NOT copied into the evidence jsonb — see §1.3, where that
    column's plaintext storage is already an open finding. Only the document
    type and issuing country are recorded as evidence, and no ID image or scan
    is captured on this path.
- **Revoking a consent — one narrow institute-scoped case (2026-09-09).**
  `POST /api/consent/:consentId/revoke`. The rule is **"attest permission =
  revoke permission"**, and the SCOPE is the security property:
  - **It applies ONLY to a record whose `identity_verification_method` is
    `in_person_clinician_attested`.** For every other record — a parent's own
    session sign, a magic-link sign, a self-sign — the rule is exactly what it
    was: the signing contact's linked user (or the student on a self-signed
    record), or a system admin. An institute member has no revoke right over
    those, and reading a student's consent (which any institute member may do)
    has never implied a right to withdraw it.
  - **Why the exception exists.** The attest path signs as a guardian contact
    with no `linked_user_id` — that absence is the reason the endpoint exists —
    so the signer rule can never admit the record's own data subject. Before
    this change, a clinic-attested consent had exactly one revoker in the whole
    system: a system admin. Every regime we implement grants a right of
    withdrawal (IL PPL §11, GDPR Art. 7(3), COPPA §312.6), and the guardian has
    no account, so the practical path is "tell the clinic" and the clinic must
    be able to act.
  - **Why NOT the broad reading.** "Any institute member may revoke any of that
    student's consents" was considered and rejected: it would let a clinic
    member tear up a consent the parent signed themselves, taking a right from
    the person who holds it. That is a strictly larger widening than the hole
    being closed. Pinned by
    `server/tests/integration/consent-revoke-permission.test.ts`, on a student
    the member demonstrably DOES have access to, so the refusal is about the
    record and not about access.
  - **One predicate.** The parity check is `attestPermissionFor` — the same
    function, including the same `ATTEST_REQUIRES_INSTITUTE_ADMIN` constant,
    that gates the attest write above. Flipping that constant tightens creation
    and withdrawal together; there is no second copy to drift.
    `revokePathFor(req, record)` holds all three rules and returns which one
    admitted the caller.
  - **Audit.** `consent_revoked` carries `details.revocation_path` —
    `signer` | `system_admin` | `attest_parity` — on EVERY revocation, so a
    clinic-performed withdrawal is a positive assertion in the row rather than
    an inference from a missing key. The parity path also carries
    `attested_by_user_id` and `identity_verification_method`, so one row answers
    "who vouched for this guardian, and who tore it up". §6.1.
  - **The cascade is unchanged** and fires on this path exactly as on the others
    (shares revoked with `cascade_reason='consent_revoked'`, AAC sessions
    terminated, failures non-fatal — the withdrawal is the binding act).
  - ~~**Residual, not closed:** a signer with no user account still has no
    self-serve withdrawal.~~ **CLOSED 2026-09-10 — see the next bullet.**
- **A PUBLIC, TOKEN-AUTHED CONSENT WRITE (2026-09-10).** `POST
  /api/consent/withdraw/confirm` revokes a consent record with **no session at
  all**. It is the only unauthenticated write on the consent surface that
  changes a `student_consent_records` row, so its rules are spelled out in full.
  Full design: `docs/student-consent-implementation.md` §5.3.
  - **Why it is public, and why `requireAuth` here would not be "more secure".**
    The holder of the right to withdraw is a guardian who signed by magic link
    (or was attested for at the desk). They have an email, a phone and no `users`
    row — `revokePathFor`'s `signer` rule resolves through
    `studentContacts.linkedUserId` and can never admit them, and the sign token
    was consumed at sign time. On the reading below, requiring a session here
    would be a permanent refusal of the right to withdraw rather than a control.
    This is the same reasoning that already makes
    `/api/consent/invitations/{redeem,sign,…}` public, and the same threat model.
  - ⚠️ **THE DRIVING PREMISE IS AN INTERPRETATION, NOT A CITATION — do not
    read the rest of this section as a stated legal rule.** Nothing in
    `shared/legal/` imposes any withdrawal-specific bar: `idv-methods.ts` governs
    what each regime accepts *for signing*, and none of the five minor-protection
    regimes carries a withdrawal clause.
    `planning-docs/student-access-permission/student-access-permission-laws.md`
    and `planning-docs/ministry-of-education-approval/` are likewise silent, and
    the only promise the system has ever made a signer
    (`IL_2026_04.rightsStatement`) says "contact the clinic". Taking GDPR
    Art. 7(3)'s "as easy to withdraw as to give" to mean *machine-driven
    withdrawal that does not depend on an employee's cooperation* is a reading —
    the one `docs/student-consent-implementation.md` §11 recorded, and the
    strictest bar any implemented regime plausibly imposes, so the one built to.
    COPPA §312.6 arguably permits a LOWER bar for revocation than §312.5(b)(2)'s
    enumerated consent methods; that latitude is deliberately not taken. If the
    premise is ever revisited, revisit this whole section with it rather than
    treating the design below as legally compelled.
  - **What stands in for the session, all of it required.** A single-use token,
    sha256 at rest under a unique index, 72h expiry, bound to ONE consent record
    (`consent_invitations.target_consent_id`) and one contact — never merely to a
    student. Delivered ONLY to an email/phone already stored for that signer;
    **a destination is never read from a request**. Plus the SAME second factor
    the sign flow used for that channel, checked immediately before the commit
    rather than merely offered. Plus an explicit `confirm: true`. Every route
    carries `authRateLimiter`.
  - **The bar is EQUAL, both directions.** Not harder than signing (per the
    Art. 7(3) reading flagged above),
    not easier (a forwarded receipt must not revoke a child's consent — the
    withdrawal terminates a live AAC session for a child who depends on the
    device). Parity is enforced by CALLING the sign flow's own functions —
    `phoneOtpService` for the SMS leg, `getChildInstituteIdNumber` /
    `normalizeIdLast4` / the same 5-attempt cap for the email leg — never by
    re-stating the rule. Where the sign flow was token-only (email channel, no
    institute ID on file) the withdrawal is token-only too, and that is derived
    from the same predicate rather than asserted. When both channels exist the
    link goes by SMS, the channel that carries a real possession factor, so the
    withdrawal bar cannot drift below the signing bar for the same person.
  - **Enumeration-safe by construction.** The receipt's entry point,
    `POST /api/consent/withdraw/request-link`, always answers `200 {success:
    true}` — for a real reference, an unknown UUID and garbage alike. It reveals
    nothing about whether the record, student or contact exists, whether the
    signer has an account, whether a channel is on file, or whether the consent
    was already withdrawn. A token presented to the wrong flow answers
    `code_not_found`, the same non-answer a random string gets.
  - **The receipt carries a REFERENCE, not a token.** `#ref=<consentId>` buys one
    thing: an email or SMS to an address you must already control — the
    password-reset shape. A live token in the receipt was rejected: a receipt is
    a document the guardian is told to KEEP and may forward, and a token in it
    would be a multi-year standing capability to end a child's AAC session. It
    would also contradict the 72h stale-link ceiling this system already applies
    to sign links. A 10-minute per-record throttle stops a replayed receipt from
    mailbombing the guardian.
  - **One table, one lifecycle.** The token is a `consent_invitations` row with
    `purpose='withdraw'` rather than a new table, so code generation, hashing,
    expiry, single-use redemption, the OTP scope id and the attempt cap have
    exactly one implementation. ⚠️ The consequence is that **`purpose` is a
    security discriminator**: `loadActiveInvitationByCode(code, purpose)` refuses
    a mismatch, and both directions are pinned in
    `server/tests/integration/consent-withdrawal-token.test.ts`. A query on this
    table that forgets the filter is a confused-deputy bug.
  - **The client never revokes on load.** `client/src/pages/ConsentWithdrawPage
    .tsx` states the consequences, gates the button behind a checkbox, and only
    the token RESOLUTION runs on mount. Email scanners and link-prefetchers
    follow URLs; the server's `z.literal(true)` on `confirm` is the second line.
  - **Audit.** Fourth `revocation_path` value, `signer_token`, and the only one
    where `userId` is NULL — that signer has no account. WHO is
    `details.revoked_by_contact_id`; HOW is
    `details.withdrawal_second_factor` (`phone_otp` | `child_id_last4` |
    `token_only`). It is deliberately not folded into `signer`, which means "an
    authenticated user who is the contact's linked account". §6.1.
  - **The cascade is unchanged** and fires here exactly as on the other three
    paths. The acting user id is null the whole way down; every
    `revoked_by_user_id` column was already nullable, so this was a TypeScript
    widening with no migration.
  - **The clinic is told.** There is no in-app notification system in this
    codebase and no clinician-readable activity feed (`/api/admin/activity-logs`
    is gated on `isAdminIdentity`, i.e. Aivota staff), so this path emails the
    student's institute ADMIN members. Scoped to THIS path only — the other three
    revocations are performed by someone already logged in.
  - **Re-issue is institute-admin, and is not a back door.** `POST
    /api/consent/:consentId/withdrawal-link` lets the clinic re-send a link when
    the guardian phones. The caller never sees the code and the link goes to the
    guardian's stored channel, so §5.2's rule — a clinic member may not tear up a
    parent-signed consent — is untouched.
- **Regime selection:** `shared/legal/minor-protection.ts` chooses one of `us_coppa | eu_gdpr_minor | uk_ico_under13 | il_general | gdpr_superset_default` based on the institute's regime + child age.
- **Recipients snapshot:** the third-party list shown at sign time is stamped into `studentConsentRecords.recipients` so audit can prove what the parent was told. Updates to the canonical list (`shared/legal/recipients.ts`) bump the consent-notice version; existing consents remain valid for *their* snapshot; new processing using a newly-added recipient requires re-consent.

### 2.5 Audit logging

```
Any student-scoped PHI GET ──> phiReadAudit middleware ─┐
Cross-institute / admin read ─> recordShareDerivedView ─┴> activityLogService.log
                                                                     │
                                                                     ▼
                                                              activity_logs (Postgres)
                                                                     │
                                                                     └─ retention per regime (§7)
```

```
AWS API call ──> CloudTrail ──> S3 (KMS encrypted) ──> 6-year retention
Network flow ──> VPC Flow Logs ──> CloudWatch Logs (KMS, audit retention)
Application stdout ──> CloudWatch Logs (KMS; app retention)
```

- The application audit log (`activityLogs`) covers user-driven PHI reads (§6.1).
- AWS CloudTrail covers infrastructure operations.
- DB query bodies are NOT logged. Only connections, disconnections and DDL —
  and, since 2026-08-26, `log_min_error_statement = panic` so that FAILED
  statements are not written out with their literal values either.
- **CloudWatch log events are not exported to S3.** Under the `hipaa` profile the
  audit groups (CloudTrail-CW, VPC flow, RDS, WAF) are retained *in CloudWatch*
  for 2192 days; only ALB access logs, S3 access logs and CloudTrail files land
  in the 6-year S3 bucket. Earlier versions of this document described a
  CloudWatch → S3 archive; no such path exists.

## 3. Storage and Residency

| Component | Service | Region (current) | Encryption | Notes |
|---|---|---|---|---|
| Application database | RDS PostgreSQL | `il-central-1` | KMS at rest; TLS in transit, `rds.force_ssl = 1` — but the client does **not** verify the server certificate (`server/db.ts` `rejectUnauthorized: false`, open item) | Multi-AZ in production |
| Object store | S3 (uploads) | `il-central-1` | KMS customer-managed; bucket policy denies non-TLS and non-KMS PUTs | Tag `DataClass=PHI`; versioned; noncurrent versions expire after 30 days. **No Glacier transition** |
| Object store | S3 (logs) | `il-central-1` | SSE-S3 (AES-256); bucket policy denies non-TLS | STANDARD_IA at 30 days, Glacier at 90, expiry at 6 years |
| Cache / pub-sub | ElastiCache Redis | `il-central-1` | At-rest (CMK) + in-transit, auth token | Fanout payloads are ID-only; snapshots retained (`redis_snapshot_retention_days`) |
| Secrets | AWS Secrets Manager | `il-central-1` | KMS | IAM-controlled |
| Static frontend | S3 + CloudFront | global edge (S3 in `il-central-1`) | TLS 1.2+ | No PHI in static assets |

### 3.1 Residency policy

The `complianceRegimes` field on `LicensePermissions` (license JSONB) declares which regimes apply to an institute. Each regime carries a `requiresInCountryResidency` flag in the registry (`shared/regime/regimes.ts`). Today the entire deployment is in `il-central-1`. Multi-region partitioning per regime is **not yet** implemented; if a regime requires residency outside Israel (e.g., GDPR-strict tenants), the deployment plan is to spin up a region-scoped instance and route by institute regime at the load-balancer / DNS layer.

### 3.2 Deployment paths

**Production has run on ECS Fargate since 2026-08-20** (`.github/workflows/deploy.yml`).
Terraform layers three profiles over the base `terraform.tfvars`:

- `ecs-lean` (**current default**) — ECS Fargate, 1 task, no Redis; WAF,
  CloudTrail, VPC flow logs and VPC endpoints off.
- `hipaa` — the same stack with everything on: WAF (+ logging), CloudTrail,
  flow logs, VPC endpoints, Redis, 2+ tasks, multi-AZ RDS, CMK everywhere,
  6-year audit-log retention.
- `lean` (legacy) — the Lambda + API Gateway path, kept as a **manual rollback
  only** (`deploy-lambda.yml`, dispatch only). No new work goes there.

`staging` is **not on AWS** — it runs on Render and therefore sits outside every
control in this document. See [`INFRASTRUCTURE.md`](INFRASTRUCTURE.md).

## 4. Encryption

### 4.1 In transit

- **Public ingress:** TLS 1.2+ (CloudFront / ALB enforce). HTTP→HTTPS redirect.
- **Internal:** ECS↔RDS is TLS (RDS `force_ssl`), but the certificate is **not
  verified** — `server/db.ts` and `server/services/realtime/postgres-bus.ts` set
  `rejectUnauthorized: false`. Bundling the RDS CA is an open item
  (§164.312(e)(2)(ii)). The **ALB→task hop is plaintext HTTP** inside the private
  subnets (target group `protocol = "HTTP"`). WS upgrade rides the same public
  TLS channel as HTTP.
- **Provider APIs:** All outbound HTTPS (Gemini, OpenAI, Anthropic, ElevenLabs, SES, SNS, Dropbox).
- **TURN:** media is DTLS-SRTP end-to-end and the coturn relay never decrypts it; the TURN **control** channel is plaintext (open item).

### 4.2 At rest

- **Postgres:** RDS encryption with the customer-managed KMS key (also Performance Insights).
- **S3 uploads:** KMS customer-managed key + bucket key; a bucket policy refuses
  a PUT that explicitly names any other SSE method.
- **Secrets Manager:** KMS (customer-managed).
- **CloudWatch Logs (every Terraform-managed group) and CloudTrail files:** KMS (customer-managed).
- **Not** KMS-customer-managed — these use SSE-S3 (AES-256) by design or by
  omission: the S3 logs bucket, the AAC updates bucket, the static frontend
  bucket, the CloudFront access-log bucket (us-east-1) and the Terraform state
  bucket. "KMS everywhere" is true of PHI and secrets, not of the whole estate.

### 4.3 Application layer

`server/services/encryption.ts` provides AES-256-GCM with a 32-byte key derived from `ENCRYPTION_KEY` via `scrypt`. Output format: `IV:authTag:ciphertext` (hex). Used for fields that are sensitive even within the database:

- `users.mfaSecret` (TOTP shared secret) — encrypted with `MFA_ENCRYPTION_KEY`, a
  key separate from `ENCRYPTION_KEY`
- `identityProviders.clientSecret` (OIDC/OAuth2 client secret)
- `identityProviders.samlSpPrivateKey` (when SAML SP signs AuthnRequests)
- `dropboxConnections.encryptedAccessToken`, `encryptedRefreshToken`

Hashed rather than encrypted (one-way, not in the list above):
`phoneOtpCodes.codeHash` and `mfaRecoveryTokens.tokenHash` (MFA recovery codes —
there is no `users.mfaRecoveryCodes` column; an earlier version of this table
named one).

`ENCRYPTION_KEY` is fetched from Secrets Manager at runtime; never in source, never in environment files committed to the repo.

**Not yet encrypted at this layer (open):** biometric identifiers
(`biometricData.faceEmbedding` / `voiceEmbedding` / `physicalDescription`),
`studentContacts.governmentIdNumber`, `instituteStudents.idNumber`,
`aacSettings.elevenlabsApiKey` and `aacSettings.localStorageEncryptionKey`.

### 4.4 Redaction

- **Teudat Zehut on read:** institute student `idNumber` returns `[REDACTED]` placeholder. See [`memory/project_id_number_redaction.md`].
- **Logging:** `console.log` calls are reviewed not to include claim payloads or query bodies.
- **AI prompts:** PHI memory-schema reads pass through redaction helpers before being concatenated into prompts.

### 4.5 Debug sinks are off in production

Several loggers write prompts, transcripts, memory values and clinical summaries
— PHI — to the container filesystem or to the `session_debug_logs` table. They
used to gate on `AWS_LAMBDA_EXEC_WRAPPER`, which is not set on ECS Fargate, so
the Lambda→ECS cutover silently turned them all on in production. There is now
**one predicate** every file logger consults
(`server/services/file-debug-log.ts`):

- `fileDebugLoggingEnabled` — false whenever `NODE_ENV` is `production` (or
  `test`); opt back in locally with `DEBUG_FILE_LOGS=true`.
- `sessionDebugPersistenceEnabled` — persistence of full untruncated prompts and
  transcripts to `session_debug_logs` requires a **server-side**
  `SESSION_DEBUG_LOGS=true` in production. The per-session trigger was a
  client-supplied `debugMode` flag, i.e. any WS client could switch on permanent
  PHI capture; the server opt-in is now required on top of it. That table still
  has no retention policy — pruning is a manual admin action (open).

### 4.6 Free-form memory keys — sensitive-field filter

`server/services/sensitive-fields.ts` is the last line of defence against
clinical data being written into `students.chat_memory` under an ad-hoc key
(`Student_AbuseHistory`, `custody_notes`, …) that has no schema, no consent gate
and no read toggle. Keys matching the pattern list (diagnosis, medication,
allergy, medical, psychiatric, insurance, SSN, custody, abuse, …) are dropped
before they can reach a prompt.

Registered memory-schema fields are deliberately **exempt** — `Student_Incidents`
and `Context_MedicalInfo` are governed by their own schema gates
(`allowReadReports`, `canWriteObject`, `requireConsentForMemoryWrite`), and since
2026-09-10 the rest of `students.chat_memory` is too: every registered
`Student_*` field now passes `requireConsentForMemoryWrite` on write, and the
blob write in `sessionService.onUpdateMemoryValues` is itself gated, so an
unregistered key that slips this filter still cannot reach the column for a
consent-pending student (§2.4). And letting a substring regex second-guess those gates is exactly why this filter was
once hard-disabled (`/incident/i` silently stripped the Monitor's own incident
channel, and the whole check was turned off rather than scoped).
`server/tests/sensitive-fields.test.ts` pins the exemption set against every
declared memory-schema field id, so a new registered field that happens to match
a pattern fails the build instead of vanishing from prompts at runtime.

## 5. Authentication and Authorization

### 5.1 Local authentication

- Email + password, password hashed with `bcrypt` (`bcryptjs`); registration uses cost 12, password reset currently uses cost 10 — **open item:** unify on cost 12 minimum or migrate to `argon2id`. Password reset via `passwordResetTokens` (single-use, short-TTL, hashed at rest).
- Session cookies (`express-session`), `Secure` + `HttpOnly` + `SameSite=Lax` (`SameSite=None` in production, required for the packaged clients' `app://` / `capacitor://` origins; CORS credential policy still gates which origins may send them). Session table in Postgres.
- **Lifetimes are per client** (`server/session-lifetime.ts`). Clinician sessions expire ABSOLUTELY: 1 day, or 30 with "remember me". An AAC device gets a 1-year cookie that slides forward while the app is in use (re-stamped at most once a day) — the device is an appliance a child cannot re-authenticate, so it stays signed in until someone signs it out, a device slot is revoked, or the account is disabled. The sliding refresh is opt-in per session, NOT `rolling: true`, so clinician expiry stays absolute.
- **Automatic logoff (§164.312(a)(2)(iii)).** Every non-AAC session (clinician,
  admin, support) also lapses after **30 minutes** without a request.
  `touchClinicianActivity` stamps `session.lastActivityAt` at most once a minute;
  `enforceClinicianIdleTimeout` (mounted in `server/userAuth.ts`) destroys an
  expired session and lets the request continue unauthenticated, so `requireAuth`
  answers 401 and the client shows its usual sign-in. The window comes from
  `SESSION_IDLE_TIMEOUT_MINUTES`, fed by Terraform's `session_timeout_minutes`
  (30 under `hipaa`); 30 minutes when unset. AAC device sessions are exempt by
  design — what protects a lost device is slot revocation (§5.6) and the
  caretaker PIN (§5.7).
- **Support (impersonation) sessions lapse after 60 minutes.** The
  `supportContext` middleware (`server/middleware/auth.ts`) checks
  `session.support.startedAt` on every request, clears the support claim once
  `SUPPORT_SESSION_MAX_MS` has passed, and writes a `support_session_ended`
  audit row with `{ reason: "expired", durationMs }`. Break-glass access into an
  institute's PHI no longer lives as long as the admin's cookie.

### 5.2 SSO

- OIDC, OAuth2, and SAML 2.0 supported (see §2.1).
- Generic claim-mapping layer normalizes provider claims into a canonical profile.
- Per-institute opt-in via `institutes.instituteIdType`; identity expiry tracked via `identity_providers.reverificationDays`.
- Documented at [`memory/project_sso_saml.md`].

### 5.3 MFA

- TOTP, secret encrypted with the application layer key (§4.3).
- Recovery codes hashed (one-way). Codes are single-use and removed on consumption (`mfaRecoveryTokens`).
- MFA can be enforced at the institute level (`mfaEnforcedByAdmin`); admins setting up MFA cannot disable it themselves while the institute enforces it.

### 5.4 Authorization — `accessCtx`

Authorization for PHI/PII reads goes through a typed access context:

```ts
type AccessCtx =
  | { kind: "institute"; instituteId: string; userId: string }
  | { kind: "student";   studentId: string }
  | { kind: "admin" };
```

- **Institute principal:** member of the institute; can see owned rows + share-derived rows (visibility helper joins `objectShares`/`standingShares`).
- **Student principal:** the AAC client itself; sees only the student's own rows.
- **Admin principal:** system admins. An admin owns nothing, so **every** row an
  admin principal reads is a cross-boundary read and fires a `view` row with
  `details.viaAdmin` (`server/services/sharing/audit.ts`). Until 2026-08-26 this
  function returned early for admin principals under a comment promising a
  "separate system-admin audit" that did not exist — the most privileged reader
  left no trail at all.

Memory-schema operations gate every read through this context. Documented at
[`memory/project_ai_access_ctx.md`].

⚠️ This section used to add "and PHI controllers". The 2026-09-10 authorization
audit found that untrue of the **REST** surface: of 246 audited routes only a
minority reach `AccessCtx` at all, and every critical finding sat on a route that
never touches it. On the REST surface `AccessCtx` is a **cross-institute
visibility refinement applied after** a student or institute gate has already
run — not the gate itself. What the gate actually is, is §5.4.2.

#### 5.4.1 One institute predicate, and a boundary that cannot fail open (2026-09-10)

The 2026-09-10 authorization audit counted **six** implementations of "may this
user touch this institute" and **three** of "is this user a member", two of the
three wrong. Phase 1 of the structural pass converged them.

**The predicate pair.** `instituteRepository.isUserMemberOfInstitute` and
`isUserAdminOfInstitute` are the answer. Both check `isActive`, both honour a
customer-support session, both refuse a nullish argument. Everything that used
to answer the question separately now routes through them:
`instituteService.verifyMembership` (the row-bearing form — same rules, plus the
`institute_users` row for callers that need the role columns), the
`getInstitutesByUserId().some(...)` list-then-scan in `routes.ts` and
`calendarService`, and the raw `getInstituteUserLink` truthiness tests in
`locationService`, `calendarService` and `institute-memory-schema` (§5.6).

One deliberate exception, kept and named rather than merged:
`instituteRepository.getActiveMembership` answers the **third-party** question —
"does this *other* user hold a live membership row" (a package grantee, a roster
entry) — and is therefore blind to support mode, because a break-glass session
over an institute must not make an arbitrary user look like a member of it.
`personChatRepository.personsShareInstitute` likewise stays its own thing: it is
person-to-person, not user-to-institute.

**Support mode is now answered identically everywhere.** `verifyMembership` used
to read the raw row, so a support agent — who holds no membership row for the
institute they are supporting — was refused by `GET /api/institutes/:id` and by
guided setup while being admitted by the predicate pair everywhere else. That
was not the safer answer, merely an inconsistent one: the agent could already
read the institute's students, reports and boards. Support sessions are
deliberate, time-boxed (§5.1) and audited with `details.viaSupportInstituteId`
(§6.1), so the predicate pair's answer is the correct one and `verifyMembership`
now agrees with it. On that path `membership` is `undefined` — there is no row.

**The `undefined` support sentinel is structurally impossible (finding F12).**
`getActiveSupportInstituteId()` returns `undefined` outside a support session, so
the short-circuit `if (getActiveSupportInstituteId() === instituteId) return true`
is `undefined === undefined` — **true** — for any caller that passes a nullish
institute id. That is exactly how the 2026-04 `PUT .../authority` escalation
worked (§2.4). The audit verified no live call site can pass `undefined` today,
but every one of them was safe by an ad-hoc truthiness guard somewhere up the
stack while the signature said `instituteId: string`, so nothing would have
stopped the next one. The guard now lives inside the helper
(`isSupportSessionFor`), and both predicates additionally refuse a nullish
institute **or** user id before any lookup. Pinned DB-free by
`server/tests/institute-predicate-guards.test.ts`, which also asserts that the
pre-fix expression really did evaluate to `true`.

**The boundary helper's fail-open sentinel — closed.** `buildClinicianCtx`
returned `undefined` for BOTH "no institute is selected" and "the caller named an
institute they are not a member of", and consumers read that one value three
different ways: `packageController` as **deny**,
`customAppRepository.getAssignedAppIds` as **no filter**, and
`reportController.requireOwningInstitute` as **allow** (its cross-institute write
gate opened). The AAC audit called this the real recurring bug. The boundary now
returns a discriminated `ClinicianCtxResult`
(`ctx` | `no_institute_selected` | `not_a_member`) and two controller helpers
map it to the refusal each route intended:

- `visibilityCtx` — for routes whose own student gate already ran and that use
  the ctx only as a cross-institute refinement (reports, programs, incidents,
  deep analysis). `no_institute_selected` passes an undefined ctx through
  unchanged; `not_a_member` is **403**, not silently unfiltered.
- `requireInstituteCtx` — for routes that cannot work without an institute
  principal (packages, custom apps). 400 `INSTITUTE_NOT_SELECTED` for the first,
  403 `NOT_INSTITUTE_MEMBER` for the second. Both were the same 400 before, so a
  genuine refusal read to the client as a missing query parameter.

`getAssignedAppIds`'s `ctx` parameter is now **required**: the optionality *was*
the vulnerability, so it is gone at the type level rather than guarded. Callers
name their principal — the AAC session passes the student it runs as, and a
clinician with no institute selected passes a `student` principal once their
direct access to the student is proven. Pinned by
`server/tests/clinician-ctx-states.test.ts` and
`server/tests/integration/institute-membership-authz.test.ts`.

⚠️ **Still open, reported not fixed:** `buildSessionAccessCtx`
(`services/sharing/sessionCtx.ts`), the AI's parallel boundary, builds its
institute principal from the caller-supplied `instituteId` **without** verifying
membership — the shape closed on the HTTP path on 2026-08-26. It is not
currently reachable (`chatController` and `chatStreamController` both call
`verifyMembership` on the body's value before initialising the session), and it
was left alone rather than fixed blind because its consumer's contract for
`undefined` is "skip the visibility filter" — returning `undefined` on a failed
check would trade a hypothetical forgery for a real fail-open. It needs the same
discriminated shape, with `sessionService` changed in the same commit.

#### 5.4.2 The student gate — named policies in `server/services/access/` (2026-09-10)

The same audit's §3 table listed **fifteen** distinct answers to "may this user
touch this student" — three of them named `requireStudentAccess`, two named
`assertStudentAccess`. Phase 1 of the structural pass moved the rules into one
module without changing who any of them admits.

**The module.** `server/services/access/` (`studentAccess.ts`, barrelled by
`index.ts`). It hosts policies, not middleware; response bodies stay with the
route. It is written **cast-free** — see the §2.4 `m.id` bug — and contains no
`any`.

| Export | Policy | Admits |
|---|---|---|
| `studentAccess(studentId, userId, {instituteId?})` | **BROAD** | active `user_students` link ∨ **any member** of a `family` institute the student is enrolled in ∨ **admin** of a `school`/`clinic` they are enrolled in |
| `hasStudentAccess(studentId, userId)` | BROAD | null-safe boolean form; a missing id is a **denial** |
| `requireStudentAccess(req, res, studentId, {shape, allowNoStudent?})` | BROAD | the 401/403-writing form; the caller supplies the bodies |
| `sharesInstituteWithStudent(principal, studentId)` | **INSTITUTE OVERLAP** | system admin ∨ the caller is in any institute the student is actively enrolled in |
| `assertSharesInstituteWithStudent(req, res, studentId)` | INSTITUTE OVERLAP | its 401/403-writing form |
| `administersStudentInstitute(principal, studentId)` | INSTITUTE ADMIN | system admin ∨ admin of one of the **student's** institutes (§5.5.1) |
| `wizardContextGrantFor` / `assertWizardContextAccess` | **UNION** | institute overlap ∨ linked `student_contacts` row ∨ active `user_students` link (§2.4) |

**These are three policies, not one with options, and the differences are
load-bearing.** A plain school STAFF member passes institute overlap and is
**refused** by the broad policy; a linked caregiver whose student is enrolled
nowhere passes the broad policy and is **refused** by institute overlap; a
system admin passes institute overlap unconditionally and is not special-cased
by the broad policy at all. The structural plan originally proposed collapsing
the broad-policy wrappers onto the consent predicate; doing so would have
changed who is allowed in both directions, so both survive as named policies
with one implementation each. The full admit/deny matrix is pinned in
`server/tests/integration/student-access-policies.test.ts`.

**Who uses which.**

- **Broad** — `boardController` (board read/write and student attachment),
  `caretakerPinController` (all three PIN routes), `incidentController` (all
  four), `voiceController` (synthesize / speak / chat). All four previously
  carried their own copy; the caretaker and incident copies were logically
  identical and separately written. Roughly sixty other call sites still call
  `studentService.verifyStudentAccess` inline (biometrics, programs, photos,
  devices, venue menus, guided setup, `packageController.canAccessStudent`, …).
  Those are *uses* of the same single implementation rather than copies of the
  rule, so they were left alone; moving them onto `studentAccess` is mechanical
  and can happen route by route.
- **Institute overlap** — every student-scoped consent read (`/active`,
  `/history`, `/authority`, `/invitations`), the `?contactId=` wizard variant,
  and the attest predicate.
- **Institute admin** — `PUT .../authority`, consent invitation create / resend,
  the `/history` "can this clinic re-send a withdrawal link" affordance and the
  re-issue endpoint behind it, and the attest predicate's second half
  (`ATTEST_REQUIRES_INSTITUTE_ADMIN`).
- **Union** — `GET /api/consent/students/:id/wizard-context`, default path only.

**`studentAccess` withholds the student row on denial.** `verifyStudentAccess`
returns the `student` row alongside `hasAccess: false` (clinical audit, pattern
6). No caller misused it, but the shape invites exactly one kind of mistake, so
the new surface's result type makes `student` reachable only on the `true`
branch. `verifyStudentAccess` itself is unchanged, so nothing that has not moved
is affected.

**Deliberately NOT merged in**, each a different right with one implementation:
`callContacts.userMayActAsStudent` (a *calling* right — link ∨ active *callable*
contact row), `services/packages/packageAccess.ts` (§1.2.1),
`studentService.getStudentLinkAuthority` (link/unlink authority, §5.5.1),
`recognition-service.getPersonFaceImageUrlForStudent` (a SQL-level restatement),
and `studentRepository.getStudentsForUserInInstitute` — a **third, wider** rule
that also grants via a **shared classroom**, the only place in the codebase that
does. It is a list query rather than a predicate and was left where it is.

**Enumeration.** Every adapter resolves permission before the resource lookup,
so a refused caller cannot tell a real student id from an invented one. Where
the resource id is not the student's — `PATCH`/`DELETE /api/incidents/:id`,
whose student is only known from the row — the leak is closed from the other
side instead: an incident the caller may not touch answers with the **same 404**
as one that does not exist. That was clinical audit §2.9, and it was previously
a 403 under a comment claiming otherwise.

### 5.5 Family/cross-institute access scoping

Access checks key off the **selected** institute, not all institutes the user is in. A user who switches institutes loses share-derived access until the new institute has its own grants. Documented at [`memory/feedback_family_access_scoping.md`]. `buildClinicianCtx` verifies that the caller is actually a member of the `instituteId` it is handed, so the context cannot be forged by supplying someone else's institute.

#### 5.5.1 Institute-derived authorization starts at the STUDENT (2026-09-10)

**The rule.** When a check's shape is "the caller administers an institute,
therefore they may act on this student", the candidate institutes MUST be
derived from the student's own active enrolments
(`instituteRepository.getInstitutesByStudentId`) and the caller tested against
those. A request-supplied institute id — body, query string or selected-context
— is never the authorization input. Proving the caller administers an institute
they named, without proving the STUDENT belongs to it, proves nothing about the
student: every admin on the platform administers *some* institute.

**Who may link a user to a student.** `user_students` rows are authorization
grants, not a contact list, so `POST /api/students/:id/link` and
`DELETE /api/students/:id/link/:userId` answer through one predicate,
`studentService.getStudentLinkAuthority(studentId, userId)`:

- an **owner** — the caller holds an active `user_students` row with
  `role === "owner"` for this student (the family's relationship to their
  child); or
- an **institute admin** — the caller administers a *school* or *clinic* the
  student is **actively enrolled in**. Family institutes are not a route here;
  a family member's authority is their own owner link.

On top of that:

- `role` is validated against `USER_STUDENT_ROLES`
  (`owner | caregiver | therapist | teacher`, exported from
  `server/services/studentService.ts` and pinned equal to the enum the AI's
  memory schema publishes). An unknown role is a 400, never a silent default.
  That list gates the ENDPOINT, not the column: `user_students.role` is bare
  `text` and legitimately holds other values from older paths (`parent`,
  `clinician`), while `verifyStudentAccess` grants on any ACTIVE link
  regardless of role — `"owner"` is the only value ever read back as privilege.
  The service-layer writers therefore stay permissive; rejecting a legacy role
  string there would be a reliability regression, and the attacker-reachable
  surface is the controller.
- **An institute admin may never grant `owner`**, to themselves or to anyone.
  Ownership carries full PHI access and the owner-only student delete; only an
  existing owner can create another owner.
- An institute admin may not re-link an existing owner either — re-linking is an
  UPDATE, so without that guard an admin could demote the owner to `caregiver`
  and then unlink them ("cannot unlink the owner" only protects a row that still
  says owner).
- The audit row records the **derived** institute, so the log says which
  institute actually justified the write.

**Found by the 2026-09-10 authorization audit.** Both handlers took the
institute id off the request and never tied `:studentId` to it, and `role` went
through as `role || "caregiver"`. Chained, that was a live privilege escalation:
any admin of any school or clinic could POST their own institute id, their own
user id and any student uuid with `role: "owner"` and receive full PHI access
plus the owner-only delete; the unlink half let them strip a student's
caregivers instead. Verified non-vacuous against the pre-fix code (HTTP 200,
resulting role `owner`) and pinned in both directions by
`server/tests/integration/student-link-authz.test.ts`.

This is the same class of defect as §2.4's `m.id` bug — one check about
institutes and students, re-typed per call site — so it is one exported
predicate, not a fifth copy, and it is written cast-free
(`for (const { institute } of enrollments)`) so `tsc` catches a recurrence.

⚠️ **Still open at the time of writing:** the AI's door to the same table,
`studentUsersOps` in `server/services/memory-schema/institute-memory-schema.ts`,
carries a private `requireInstituteAdmin` with the identical shape — it trusts
`ctx.all.instituteId` and never ties `ctx.all.studentId` to it — and its `add`
and `update` ops pass `value.role` through without the owner restriction. The
reachable student set there is already access-scoped, so it is narrower than the
HTTP hole was, but it should be moved onto `getStudentLinkAuthority`.

### 5.6 Session revocation — devices and workforce termination

A session that has already been issued must be killable server-side.
`server/services/sessionInvalidation.ts` is the one place that happens; it deletes
rows straight out of the `sessions` table (connect-pg-simple) rather than waiting
for a cookie to expire.

- `deleteUserSessions(userId)` — every persisted session for a user, **plus**
  every live realtime socket that user holds on this task (`room-registry`
  `socketsForUser`, closed with code 4001 `session_revoked`); a deleted session
  row only stops the *next* request, so an already-authenticated stream would
  otherwise keep flowing. Called on password reset, MFA recovery, and
  **removal from an institute** (`instituteService.removeMember`) — workforce
  termination now ends access immediately instead of up to 30 days later.
- `deleteSessionsForDevice(deviceId)` — an AAC session is bound to the registered
  device at login (`session.aacDeviceId`), so revoking a device slot
  (`studentDeviceService`) purges the session belonging to that tablet. Without
  it a lost or retired device kept a working, year-long, sliding cookie.

Caveat worth recording: the socket sweep is per-process. Under the `hipaa`
profile's multiple tasks, sockets held on the other tasks end at their next
auth-bearing request rather than instantly.

**The deactivation rule now actually holds (C9, closed 2026-09-10).** Removal
from an institute is a **soft** delete — `instituteService.removeMember` →
`instituteRepository.removeUserFromInstitute` sets `isActive: false` and leaves
the `institute_users` row in place — so "is this user a member" and "is this row
present" are different questions. Until this date three call sites asked the
second one and acted on the answer:

- `locationService.isInstituteMember` (`return !!link`) and
  `locationService.canEdit` (`return !!link?.isAdmin`), and
- `calendarService.canUserEditEvent` (`if (link?.isAdmin)`), plus
- the AI's calendar-event writer in `institute-memory-schema` (the same
  `!link?.isAdmin` test).

A terminated staff member therefore kept read/write on that institute's
`locations` and, if they had been an institute admin, edit and delete on its
calendar events — across `GET/POST /api/locations`, `GET/PATCH/DELETE
/api/locations/:id` and `PATCH/DELETE /api/calendar/events/:id`. That directly
contradicted the paragraph above, which has claimed since it was written that
workforce termination ends access immediately. Session eviction was doing its
job; the resource gates were not.

All four now go through the §5.4.1 predicate pair, which checks `isActive` — as
`isUserMemberOfInstitute` and `isUserAdminOfInstitute` always did, which is why
promoting them was the fix rather than patching each site. Found by the
**2026-09-10 authorization audit** (`planning-docs/authz-audit-clinical.md`,
finding C9) and pinned by
`server/tests/integration/institute-membership-authz.test.ts`, whose
non-vacuity assertion is in the test itself: after deactivation the membership
row is still present and still carries `isAdmin: true` — precisely what the
pre-change code read — while the predicates say no. Verified non-vacuous against
the reverted source as well (the deactivated admin was ADMITTED to edit and
delete another member's location, and to edit an institute calendar event).

### 5.7 Caretaker PIN on AAC devices

The AAC device is signed in for a year and operated by a child, so the caretaker
surfaces on it — switch student, manage devices, sign out (including
hold-to-logout) — are gated behind a per-student PIN
(`server/services/caretakerPinService.ts`). The PIN is 4–8 digits, stored as a
bcrypt hash (cost 12) in its own `student_caretaker_pins` table rather than on
`aacSettings`, which is serialized to clients. The API never returns the hash or
the PIN: the device can only ask "is a PIN set" and "did this guess match", and
the verify endpoint is rate-limited (5 attempts / 15 min per IP + student). Set
from the clinician panel by anyone with access to the student. Setting or
changing it is audited.

### 5.8 Platform-admin authority — a self-declared role confers nothing (2026-09-10)

**What the two gates mean now.** Platform-admin authority is carried by
COLUMNS, and only by columns:

| Gate | Predicate | Who has it |
|---|---|---|
| `requireSystemAdmin` | `users.is_system_admin` | the two production admin rows, and any `admin_users`-backed backoffice session (`adminAuthService.adaptAdminAsUser` presents it with the flag set). A plain `is_admin` account is refused |
| `requireAdminSection(key)` | `isAdminIdentity(user)` **and** the section is in `admin_users.permissions` | backoffice admins only — strictly narrower still, since a `users.is_admin` row is not an admin *identity* |

There is **no general "is an admin" door.** `requireAdmin` — a third gate that
admitted `users.is_admin` OR `users.is_system_admin` — was DELETED on 2026-09-10
together with all 20 route registrations behind it (phase 0a of the
authorization structural pass). None had a client call site: the backoffice
drives the section gates exclusively and has no "users" section. Anything new
under `/api/admin/*` names a section or `requireSystemAdmin`; re-introducing a
bare admin tier is a regression, pinned by
`server/tests/admin-privilege-claims.test.ts`. The three account/billing writes
that had to survive moved onto sections: the access-review off switch
(`PATCH /api/admin/users/:id`) and MFA enforcement onto `admins`, credit-package
authoring onto `licenses`.

**`users.user_type` is a profile label, not an authority, and no gate may test
it.** It is written verbatim from the request body on the public registration
path, so treating it as a claim is the same as accepting the claim from the
attacker. `"admin"` remains a legal *value* — `adaptAdminAsUser` stamps it on
the backoffice pseudo-identity and two production rows carry it — it simply
means nothing. `shared/schema.ts` makes the distinction structural: the public
`registerSchema` validates against `SELF_ASSIGNABLE_USER_TYPES`
(`Teacher | Caregiver | SLP | Parent`), while `ALL_USER_TYPES` — which still
includes `"admin"` — is used only by admin-authenticated update paths. A
server-side insert of a legitimate admin is unaffected: it sets the flags, which
no schema on any request path can reach.

**The finding.** Found by the 2026-09-10 authorization audit
(`planning-docs/authz-audit-admin.md`, finding C1) as a live, remotely
exploitable privilege escalation reachable by an **anonymous** party in two HTTP
requests:

1. `POST /auth/register` with `"userType": "admin"` in the body —
   `registerSchema`'s enum accepted it, `userService.registerUser` spread it into
   the insert and `user_type = 'admin'` was persisted verbatim.
2. Any of the `requireAdmin` routes — the gate read
   `user.userType !== "admin"` as a privilege claim, so the self-issued value
   passed. `GET /api/admin/users` then answered `res.json({ users })` over
   `db.select().from(users)`, and the payload carried every account's bcrypt
   hash and encrypted TOTP seed (see the allowlist note below).

Step 2 is now impossible twice over: the `userType` clause was removed when the
finding was fixed, and on 2026-09-10 the gate and every route it reached were
deleted outright.

Verified non-vacuous against the pre-fix tree: registration returned **HTTP
200** and wrote the row, a `user_type='admin'` / `is_admin=false` /
`is_system_admin=false` row **passed `requireAdmin`**, and the
`GET /api/admin/users/:id` payload contained `"password":"$2b$12$…"` and
`"mfaSecret":"…"`. Pinned in both directions by
`server/tests/admin-privilege-claims.test.ts` (DB-free) and
`server/tests/integration/admin-privilege-escalation.test.ts` (DB-backed,
asserting the persisted ROW). Since the 0a deletion those suites also pin the
absence: `requireAdmin` is not exported, and `adminController` carries no
platform-user handler and no unbounded `system_settings` writer.

**Production was verified unexploited.** 14 user rows; exactly two privileged
(`opher@aivota.ai`, `daniel@aivota.ai`), both carrying `is_admin = true` AND
`is_system_admin = true`, and both the only rows in `admin_users`. No account
depended on the `userType` clause, so removing it locks nobody out and **no data
migration is required**. Two legitimate rows still carry `user_type = 'admin'`;
that is now inert data. A backfill normalising them is optional cosmetics, not a
control, and is deliberately not proposed.

**`requireSystemAdmin` did not share this weakness** — it never tested
`userType`, and `is_system_admin` cannot be set from a request body. Its own,
unrelated weakness is still open: `adaptAdminAsUser`
(`server/services/adminAuthService.ts`) stamps `isSystemAdmin: true` on **every**
`admin_users` row regardless of that row's `permissions`, so a section-scoped
backoffice admin passes it (audit finding F1, with F2's three fail-open `["*"]`
permission defaults). Those are their own round.

**Admin user endpoints emit a positive allowlist — and then stopped existing.**
`GET /api/admin/users`, `GET /api/admin/users/:id` and the general
`PATCH /api/admin/users/:id` first stopped emitting raw `users` rows (they
emitted `ADMIN_USER_VIEW_FIELDS`) and were then deleted entirely on 2026-09-10,
so no route serialises a `users` row any more. `server/services/userView.ts` is
KEPT, with its pins in `admin-privilege-claims.test.ts`, as the required shape
for any future route that needs to: it is a positive list, and a denylist would
not have held, because those rows come back from
`userRepository.getAllUsers()` via `hydrateRecords("users", …)`, which is the
external-storage **rehydrator**, and `server/external-storage/registry.ts`
declares the `users` core tier as `[…,"password","mfaSecret",…]` — so the
credential columns are actively pulled back INTO the row object, and any new
sensitive column would be too. Excluded by construction: `password`,
`mfaSecret`, `chatMemory`, `googleId`, `externalStorage`, and anything added to
the table in future. The students attached to each user row are reduced to
`{ id, name, createdAt }` by the same mechanism — the account-management screen
needs to know WHICH children an account reaches, not their `birthDate`, `gender`
or `chatMemory`.

**Related, reported not fixed:** `requireSLPPlan` exists in two copies
(`server/middleware/auth.ts` and `server/userAuth.ts`) and both admit on a
self-declared `userType === "SLP"`; the `userAuth.ts` copy also tests
`userType === 'Admin'`, a capital-A string that is not a legal value of the
column anywhere and is therefore dead. That gate is a subscription/feature check,
not a privilege boundary — but "the plan gate believes the registration body" is
the same shape as this finding and should be closed on its own terms.

## 6. Audit Logging

### 6.1 Application audit (`activity_logs`)

Schema: `event_type, subject_type1/id1, subject_type2/id2, instituteId, userId, details JSONB, createdAt`.

- **Owned reads:** `server/middleware/phi-read-audit.ts` writes one `view` row per
  student-scoped PHI GET — `{ user, institute?, view, student, details.route }` —
  across the whole student surface (reports, incidents, programs, contacts,
  photos, boards, consent, AAC known-people / people-directory / person-photo,
  dual-session, deep-analysis list). It records *which kind of record* was read,
  not which fields; the per-controller `view` rows still add that where they
  exist. Identical `(user, route, student)` reads are coalesced to at most one
  row per 5 minutes per process, because the AAC device polls some of these
  routes every few seconds. `PHI_READ_RULES` is pinned by
  `server/tests/phi-read-audit.test.ts`.
- **Cross-institute and admin reads:** every share-derived PHI read fires `view`
  via `recordShareDerivedView`; admin principals fire one for every row they read
  (§5.4).
- **Support (impersonation) sessions:** `support_session_started` /
  `support_session_ended` on the institute, and every activity row written while
  a support session is active additionally carries `details.viaSupportInstituteId`,
  so an impersonated action is distinguishable from the admin's own.
- **Exports:** `export` — PHI leaving the system as a file (board export, CSV,
  backup). Subject is the exported object; subject2 the student; details carry
  `{ format }`. Board exports emit it today; the CSV/gridset/snappkg export
  routes and Dropbox backups are **not yet wired to it** (open).
- **Share lifecycle:** `created`, `guardian_approved`, `redeemed`, `accepted`, `declined`, `revoked`, `expired` for `studentShareInvites`; `granted` / `revoked` for `standingShares`.
- **Consent lifecycle:** `consent_signed`, `consent_revoked`, `consent_re_signed`, `guardian_id_verified`, `minor_threshold_crossed` for `studentConsentRecords`. `consent_revoked.details.revocation_path` is one of `signer` / `system_admin` / `attest_parity` / `signer_token`; on `signer_token` (§2.4, the public withdrawal) `userId` is NULL because that signer has no account, and `details.revoked_by_contact_id` + `details.withdrawal_second_factor` carry who withdrew and how they proved it. `guardian_id_verified` is emitted by the in-person attestation path (§2.4): subject 1 is the `student_contact`, subject 2 the student, `userId` the attesting clinician, and `details` carries `attestingClinicianUserId`, `identityVerificationMethod`, `guardianPresent` and the inspected document's type/country. An attestation therefore leaves two rows — this one for the attesting act, and `consent_signed` for the record — and both are distinguishable from a self-signed consent by `details.identityVerificationMethod`.
- **Auth events:** `auth_login_success`, `auth_login_failure`, `auth_logout`, `auth_mfa_challenge`, `auth_mfa_success`, `auth_mfa_failure`, `auth_password_reset_requested`, `auth_password_reset_completed`. Logged with IP and user-agent in `details` for forensics; failures log `attemptedEmail` instead of `userId` (privacy-preserving).
- **Erasure lifecycle:** `student_erasure_requested`, `student_erasure_cancelled`, `student_erasure_completed`. Exempt from retention pruning (compliance evidence — see §6.3).
- **Content-package publication:** `package_published`, `package_unpublished`, `package_approved`, `package_rejected`. The `package_published` row carries the publisher's attestation (`{ noPersonImages, at, byUserId }`) and the board count — it is the record that content leaving the owning institute did so by an affirmative act of a named person, not a default or an automated one. See §1.2.1.

### 6.2 Infrastructure audit

- AWS CloudTrail: every management-plane API call. KMS encrypted, multi-region,
  log file validation enabled. **Object-level (data) events cover two buckets
  only** — `uploads` (PHI) and `aac_updates` (the AAC release/manifest bucket);
  the high-volume logs bucket is deliberately excluded. It is not "all S3
  object-level operations".
- VPC Flow Logs: all network metadata; CMK-encrypted; `audit_log_retention_days`.
- ALB access logs: HTTP request metadata (no bodies).
- WAF logs: BLOCK/COUNT decisions only, `authorization` and `cookie` headers
  redacted at write time, CMK-encrypted group.

### 6.3 Retention by regime

`shared/regime/regimes.ts` declares `auditRetentionDays` per regime. The resolver `resolveAuditRetentionDays(regimes)` returns the strictest (longest) value across an institute's regimes:

| Regime | Min retention |
|---|---|
| `il_moe`, `il_health` | 7 years (2,555 days) |
| `us_hipaa` | 6 years |
| `us_ferpa` | 5 years |
| `us_coppa`, `us_section_508`, `eu_gdpr`, `eu_en_301_549` | 1 year |
| `uk_dfe` | 7 years |
| Default (no regime) | 1 year |

**Current implementation:** S3 audit logs (ALB access, S3 access, CloudTrail
files) retained 6 years. CloudWatch retention is split in two
(`terraform/variables.tf`): `app_log_retention_days` for app/debug groups (90
under `hipaa`, 14 under `ecs-lean`) and `audit_log_retention_days` for the audit
groups — CloudTrail-CW, VPC flow, RDS `postgresql`/`upgrade`, WAF — which the
`hipaa` profile sets to **2192 days (6 years)**. There is no CloudWatch → S3
export path, so under `hipaa` the audit groups meet the 6-year requirement by
staying in CloudWatch, not by being archived.

The application `activity_logs` retention cron (`server/services/activityLogRetentionCron.ts`, `runActivityLogRetentionCheck`) is implemented and tested. It runs daily, scans every institute, and deletes rows older than `resolveAuditRetentionDays(institute regimes)` per row's institute (or the strictest known retention for orphan / `instituteId IS NULL` rows), and is skipped under `NODE_ENV=test`.

**Compliance-evidence exemption:** rows with `event_type IN ('student_erasure_requested', 'student_erasure_cancelled', 'student_erasure_completed')` are never pruned — they outlive every retention window because they prove we honored a right-to-erasure request. The exempt set is exported as `ERASURE_AUDIT_EVENT_TYPES` from `studentErasureService.ts`.

### 6.4 Maintenance crons — one scheduler, both entrypoints

The daily maintenance jobs (consent-threshold checks, activity-log retention
prune, right-to-erasure hard-delete sweep, spend thresholds, package-link
reconcile) are scheduled from a single module,
`server/services/maintenanceCrons.ts`, which **both** entrypoints call —
`server/index.ts` (dev) and `server/app.prod.ts` (ECS).
`server/tests/maintenance-crons-wiring.test.ts` pins that they do.

This closed a real production gap: each cron used to ship its own `schedule*()`
and only the dev entrypoint called them, while `app.prod.ts` called none under a
comment claiming they "fire normally here". In production the erasure
hard-delete, the audit prune and the minor-threshold consent re-check therefore
never ran. The EventBridge fallback did not cover it either — it was gated on
`var.use_lambda && var.enable_cron_scheduler`, so it produced no resources on ECS.
Over-retention was conservative under every regime; the missing erasure sweep was
not.

Every run takes a cluster-wide Postgres session advisory lock
(`server/services/cron-lock.ts`) on a dedicated pooled connection, so exactly one
of the 2–10 ECS tasks does the work and a crashed task releases its lock with its
session. The first sweep after boot backfills anything that fell due while the
crons were inert.

## 7. Sub-processors

Canonical list lives at `shared/legal/recipients.ts`. The list is stamped onto `studentConsentRecords.recipients` at sign time so consent records are immutable.

| Category | Vendor | Purpose | Region |
|---|---|---|---|
| `cloud_hosting` | Amazon Web Services | Application hosting and encrypted-at-rest data storage | `il-central-1` (current) |
| `llm_provider` | Google Gemini Live | Realtime AAC interaction (live mic audio + camera video) and clinician chat when configured | EU/US (Google-managed) |
| `llm_provider` | Anthropic Claude | Monitor/moderator role — supervises the AAC session and manages memory, i.e. processes conversation transcripts; clinician chat when configured | US |
| `llm_provider` | OpenAI | Communication-symbol icon generation from short text tags | US |
| `tts_provider` | Cloud TTS providers (Google Cloud TTS, ElevenLabs) | Speech synthesis for AAC voice output | US |
| `sub_processor` | Pixabay | Stock-image search for the AAC picture app — receives only the short English search word; results are fetched server-side and re-served from Aivota | US |
| `auth_provider` | Google OAuth (when used) | Federated authentication | US |
| `sub_processor` | Email and SMS delivery (AWS SES / AWS SNS) | Transactional email & SMS, OTP delivery | varies |

Two divergences to close, listed here rather than silently reconciled:

- **External IdPs** (e.g. IL MoE Sapakim) are named in this document but are not
  a row in `recipients.ts` — they are the institute's own identity provider,
  disclosed per engagement.
- **Dropbox** (per-user opt-in board backup, `server/services/dropboxService.ts`)
  is live in the product and has **no entry in `recipients.ts`**, so no consent
  snapshot names it. Session-recording storage has no entry either. Both are
  open items. There is no Stripe/RevenueCat integration in the codebase today.

Transactional email is **AWS SES** (SESv2 `SendEmail`, authenticated by the
task/Lambda role — no SMTP secret). Earlier versions of this document named
Resend; there is no Resend code path.

Adding a sub-processor:
1. Update `shared/legal/recipients.ts`.
2. Bump the consent-notice version (`shared/legal/consent-notices/`).
3. Re-consent flow runs for new processing involving the new vendor; existing consents remain valid for their snapshot.

**Known process lapse:** `recipients.ts` was changed materially (Anthropic split
from OpenAI, live A/V added to the Gemini entry) without the consent-notice
version constant being bumped. Step 2 was skipped and should be reconciled.

## 8. Backup, DR, Retention

- **RDS automated backups:** 35 days when `environment = prod` (7 otherwise). Multi-AZ in production.
- **S3 versioning:** enabled on the PHI uploads bucket; noncurrent versions expire after 30 days. The **Glacier lifecycle applies to the logs bucket**, not to uploads.
- **Redis:** treated as ephemeral (fanout payloads are ID-only), but daily snapshots ARE retained (`redis_snapshot_retention_days`) so a replaced node has a recovery story.
- **PITR:** RDS continuous backup supports point-in-time recovery within retention window.
- **Disaster recovery:** the RTO ≤ 4h / RPO ≤ 5m figures are a **design target, not a tested capability**. There is no backup/restore or failover script in `scripts/`, no `aws_backup_plan` in `terraform/`, no cross-region snapshot copy, and no dated restore drill. RDS `backup_retention_period` is the only implemented control. A criticality analysis, an emergency-mode plan and a dated drill are **open** (§164.308(a)(7)(ii)).
- **Session recordings (AAC device, local disk):** clips are pruned by age before the size budget, default **30 days**, configurable per student 1–365 (`shared/aac/session-recording.ts`; the folder refuses UNC paths and cloud-sync roots). Recordings live on the device and are outside the server-side erasure cascade.
- **User data deletion:** GDPR/IL/COPPA "right to erasure" is implemented end-to-end — soft-delete tombstone, 30-day cancellation window, then a scheduled hard-delete cascade (§12.3). The sweep now actually runs in production (§6.4).

## 9. Incident Response

### 9.1 Detection

- CloudWatch alarms (CPU/memory/5xx, RDS health, low storage). See `INFRASTRUCTURE.md` for thresholds.
- **Failed-login surges** are real: the app writes an `[auth] login_failed` marker
  on every rejected password/MFA attempt, a CloudWatch metric filter turns each
  line into an `AiVota/FailedLoginAttempts` data point, and the existing alarm
  fires on >10 in 5 minutes. Before 2026-08-26 the alarm watched a metric nothing
  emitted.
- **GuardDuty** (when enabled): findings of severity ≥ 4 are routed to the alerts
  SNS topic by an EventBridge rule.
- **Delivery:** the alerts topic has an email subscription
  (`var.alert_email`, `alerts@aivota.ai` in both ECS profiles) and the KMS key
  policy grants `cloudwatch.amazonaws.com` and `events.amazonaws.com` the
  permission to publish to the encrypted topic. Both were missing — the topic had
  no subscriber and the CMK blocked the publish — so every alarm fired into the
  void.
- Unusual share-grant patterns: still planned.

### 9.2 Triage and notification timelines

`shared/regime/regimes.ts` declares `breachNotificationHours` per regime. The resolver `resolveBreachNotificationHours(regimes)` returns the strictest (shortest) window for an institute.

| Regime | Window |
|---|---|
| `eu_gdpr` | 72 h (Art. 33) |
| `us_coppa`, `us_section_508`, `uk_pba_2018`, `uk_dfe`, `eu_en_301_549` | 72 h |
| `il_moe`, `il_health`, `il_general` | 30 days (~720 h) — IL Privacy Protection Law |
| `us_hipaa`, `us_ferpa` | 60 days (~1,440 h) |

For an institute with mixed regimes (e.g. `il_moe` + `eu_gdpr`), the helper returns 72 h.

### 9.3 Process

1. **Page** on-call engineer (CloudWatch alarm or GuardDuty finding → SNS → the
   subscribed `alert_email`). Note the subscription must be confirmed once, from
   the SNS confirmation mail sent after apply; until then the topic has no
   deliverable endpoint.
2. **Contain** — disable the affected component (revoke creds via Secrets Manager rotation, scale down to halt processing if needed).
3. **Assess** — identify scope, data class affected, regimes implicated.
4. **Notify** — within the shortest applicable window: regulator(s), affected users (via guardian if minor), institute coordinators.
5. **Remediate** — fix root cause; rotate any leaked secrets; revoke any leaked tokens.
6. **Post-mortem** — write up cause + corrective actions; attach to compliance evidence file.

Notification templates live at `server/services/incident-templates/` — three types (PHI breach, security breach, vendor incident) × two locales (en, he), filled via `incidentTemplateService.fillIncidentTemplate(...)`, which substitutes incident-specific facts into `{placeholder}` tokens. See `incident-templates/README.md` for the inventory and review process.

Three honest limits on this machinery:

- **There is no dispatcher.** `fillIncidentTemplate` has no production caller —
  every reference is documentation or its unit test. It is a string formatter;
  meeting the 72 h / 30 d / 60 d windows is today a manual copy-paste, and there
  is no breach register.
- **The templates are covered-entity→individual shaped.** They address the
  guardian directly and promise regulator notification. As a **Business
  Associate**, Aivota must notify the covered entity (§164.410), which then
  notifies individuals and HHS. No template models that handoff — **not written**.
- Counsel review of the existing templates is still pending.

## 10. Penetration Testing & Vulnerability Management

### 10.1 Cadence

- **Internal pre-audit:** before each external test or major release: `npm audit`, `gitleaks`, OWASP ZAP baseline against staging, header check.
- **External penetration test:** annual; required by IL MoE Sapakim before vendor approval (Experis 2026).
- **Continuous:** GitHub Dependabot + npm audit on PRs; npm `audit:critical` script gates release builds.

### 10.2 Severity SLA

| Severity | Triage | Remediation target |
|---|---|---|
| Critical | 24 h | 7 days |
| High | 72 h | 30 days |
| Medium | 1 week | 90 days |
| Low | best effort | release-aligned |

### 10.3 Findings tracking

Each external-test finding becomes one issue tagged `pen-test-finding`. Production deploys are blocked until all critical findings are closed. Remediation evidence (PR link + retest result) is attached to the finding before close.

### 10.4 Standards followed

- **OWASP Top 10** — input validation (Zod at every controller boundary), output encoding, parameterized queries (Drizzle), CSRF (allowlist-checked Origin/Referer middleware globally on non-GET routes; SSO `state` token on OIDC; SAML `RelayState` token on SAML), HSTS / X-Frame-Options / X-Content-Type-Options / Referrer-Policy via `helmet`. A global application CSP is still deferred until per-domain directives are tuned (Vite HMR + Google AI + S3 + WS).

**Games CSP (shipped).** The embedded games are served by the same Express app
that serves `/api`, on the same origin as the session cookie, and their iframes
carry `allow-scripts allow-same-origin` — which voids the sandbox. The mitigating
control is therefore a per-response CSP built by `buildGamesCsp`
(`server/games-static.ts`) on every `/games` request: a path-scoped `connect-src`
(only `/games/`, `/api/custom-symbols/`, `/auth/login` and the
`/ws/social-bot` socket — so a game script cannot `fetch('/api/…')` with the
clinician's cookies), `script-src 'self' 'nonce-…'` with the login page's inline
script nonced, `object-src 'none'`, `base-uri`/`form-action 'self'`, and a
`frame-ancestors` that allows only `'self'` and `app:` in production. Pinned by
`server/tests/games-static-csp.test.ts`.
- **AWS Well-Architected — Security pillar** for infrastructure (see `INFRASTRUCTURE.md`).
- **WCAG 2.1 AA** for accessibility (see `client/src/pages/accessibility-statement.tsx` and `planning-docs/wcag-audit-icon-buttons.md`).

## 11. Cross-References

- [`INFRASTRUCTURE.md`](INFRASTRUCTURE.md) — AWS, networking, IAM, build pipelines, environments
- `shared/regime/regimes.ts` — regime registry (data residency, retention, breach windows)
- `shared/legal/recipients.ts` — sub-processor canonical list
- `shared/legal/idv-methods.ts` — identity-verification methods per regime context
- `shared/legal/minor-protection.ts` — minor-consent regime selection
- `server/services/sharing/audit.ts` — share-derived view logging
- `server/services/identityService.ts`, `saml-helpers.ts`, `identity-claim-mapping.ts` — auth + federation
- `server/services/encryption.ts` — application-layer AES-256-GCM
- `server/session-lifetime.ts` — per-client session lifetimes + clinician idle timeout (§5.1)
- `server/services/sessionInvalidation.ts` — server-side session + live-socket revocation (§5.6)
- `server/services/caretakerPinService.ts` — AAC caretaker PIN (§5.7)
- `server/middleware/phi-read-audit.ts` — per-request owned-read audit (§6.1)
- `server/services/realtime/ws-auth.ts`, `ws-ticket-store-pg.ts` — WS upgrade Origin check + cross-task single-use tickets (§2.2)
- `server/services/maintenanceCrons.ts`, `server/services/cron-lock.ts` — the daily jobs and their advisory lock (§6.4)
- `server/services/file-debug-log.ts` — the one debug-sink predicate (§4.5)
- `server/services/sensitive-fields.ts` — free-form memory-key filter (§4.6)
- `server/games-static.ts` (`buildGamesCsp`) — games CSP (§10.4)
- `shared/aac/session-recording.ts` — on-device recording retention (§8)
- `planning-docs/student-consent-onboarding-plan.md` — consent system rationale
- `planning-docs/cross-institute-sharing-plan.md` — share system rationale
- [`planning-docs/aac-packages-plan.md`](../planning-docs/aac-packages-plan.md) — content packages: the row-scoped `boards` model (§1.2.1), the content classes, and the publication gate
- `server/services/packages/packageAccess.ts` — package permission resolver
- `shared/package-validation.ts`, `server/services/packages/packageContent.ts` — package content gate
- `server/services/packages/symbolImageAccess.ts` — access gate for person-image symbols

## 12. Open Items (tracked, must be closed before regulator submission)

1. ✅ **Application audit-log retention (2026-08-26):** the prune, the erasure sweep and the other three daily jobs are scheduled from `server/services/maintenanceCrons.ts`, which both `server/index.ts` and `server/app.prod.ts` call, under a cluster-wide advisory lock. A wiring test pins it. See §6.4.
2. **Multi-region residency:** all infrastructure is in `il-central-1`. EU/US tenants requiring local residency need a region-routing layer.
3. ✅ **Right-to-erasure automation (2026-05-07):** soft-delete + scheduled hard-delete pipeline shipped. `studentErasureService.softDeleteStudent` tombstones the student (sets `deletedAt` / `scheduledHardDeleteAt`, revokes user_students + institute_students links, revokes object/standing shares), with a 30-day default cancellation window (`STUDENT_ERASURE_WINDOW_DAYS` env var). `studentErasureCron` sweeps daily and physically cascades through ~25 PHI tables in a single transaction. After the DB commits, the cron also deletes the linked biometric face image from S3 (`s3Service.delete`); failures are surfaced via `result.s3KeysFailed` so ops can drive a manual bucket cleanup, but the DB delete is not rolled back. Admin endpoints under `/api/admin/students/:id/erase[*]`. Audit events `student_erasure_{requested,cancelled,completed}` are exempt from retention pruning.

   **Biometric release invariant (2026-08-03):** `biometric_data` is *referenced, never referencing* — `users`, `students`, and `student_contacts` each hold the FK, so a row survives its last holder and becomes unreachable: a face embedding + S3 photo that no UI and no erasure sweep can find again. Anything that drops a reference — hard-deleting an entity, or re-pointing a contact at a linked person's canonical record — must call `releaseBiometricData(id, tx?)`, which deletes the row only once no holder remains and returns the orphaned S3 key for the caller to sweep (`releaseBiometricDataAndImage` does both for non-transactional callers). Wired into `userRepository.deleteUser`, the erasure cascade (contacts' own records, which the cascade previously left behind), and both contact re-point paths. `npm run db:gc-biometric [-- --apply]` sweeps rows orphaned before the guard existed.

   **Sharing requires a live link (2026-08-04):** a `student_contacts` row shares a user's or student's biometric record ONLY while `linkedUserId`/`linkedStudentId` says it is that same person. Setting a link write-through-syncs `biometricDataId`; **clearing** one now nulls it (`updateContact`), because a contact who is no longer that person must not keep writing to their face record. Before that, an unlinked contact kept the borrowed id and its next photo upload overwrote the linked person's photo, anchor embedding, and AI descriptors — one contact's photo landed on a student's record this way. Defence in depth: `ensureBiometricData` refuses to hand an unlinked contact a record any other row still holds, minting a fresh one instead, so a pre-existing bad pointer can't corrupt a face on its next write. `db:gc-biometric` reports (but never auto-repairs) unlinked contacts sitting on shared records — deciding whose face is on the record is a human call. Note that a photo replaced this way is recoverable only because the uploads bucket has versioning enabled; the overwritten embedding and descriptors are not.

   **One account, one contact (2026-08-04):** the same rule read forwards. Because choosing an account means "this contact IS that person", two contacts of one student may not point at the same `linkedUserId`/`linkedStudentId` — they would claim one human twice and both would write to that person's face record. `applyLinkInvariants` rejects it with `ContactLinkError('DUPLICATE_LINK')` (HTTP 409) on create, on update, and on the AI's contact-edit path; `getLinkableEntitiesForStudent` marks already-claimed accounts (`takenByContactId`) so the picker greys them out before a save is attempted. Only *active* contacts hold a claim — soft-deleting one frees the account. The rule is per-student: two different students may each list the same person. This was a real failure mode, not a hypothetical: users read "linked to" as "related to" and linked a relative's contact to the wrong account, which is how a contact's photo replaced a student's. The UI now says "same person as" rather than "linked to" for exactly that reason.
4. ✅ **Login event audit (2026-05-06):** `authController` writes 8 auth event types (`auth_login_success`, `auth_login_failure`, `auth_logout`, `auth_mfa_challenge`, `auth_mfa_success`, `auth_mfa_failure`, `auth_password_reset_requested`, `auth_password_reset_completed`) to `activity_logs` with IP + user-agent in `details`. Failure rows log `attemptedEmail` instead of `userId` for privacy. Migration `0097_fast_molecule_man` added the enum values.
5. ✅ **Incident notification templates:** committed to repo at `server/services/incident-templates/` (3 types × en/he, filled via `incidentTemplateService.fillIncidentTemplate`). Initial scaffold landed 2026-05-07; first counsel review still pending.
6. **Per-institute breach contact:** institutes don't currently store a designated breach-notification address; today we contact the institute admin email.

### 12.1 Open items added by the 2026-08 HIPAA remediation pass

Each of these is **not implemented**; they are listed so the doc does not read as
a claim of completeness.

7. **RDS TLS certificate verification** — `server/db.ts` and `postgres-bus.ts` use `rejectUnauthorized: false`. Bundle the RDS CA and set `rejectUnauthorized: true` with `servername`. §164.312(e)(2)(ii)
8. **CloudWatch → S3 audit export** — no subscription filter / Firehose / export task. The `hipaa` profile meets 6 years by retaining audit groups in CloudWatch instead.
9. **Secrets Manager rotation** — not configured for the RDS master or the app secrets; every human DB session uses the shared `aivota_admin` role, and SSM sessions are not logged.
10. **Container hardening** — no `readonlyRootFilesystem`; ECS Exec is enabled; the image is deployed by the mutable `:latest` tag.
11. **coturn hardening** — plaintext TURN control channel, shared secret in `user_data`, no log shipping or patch automation. (Media is DTLS-SRTP end-to-end.)
12. **Terraform state bucket** — holds generated secrets in cleartext with no bucket policy, no access logging and no Object Lock.
13. **BAA template** — none exists in the repo, and `us_hipaa` is a label that changes only two numbers in `shared/regime/regimes.ts`; no service branches on it, and `lookupConsentNotice({country:"US"})` returns undefined so a US institute cannot sign consent at all.
14. **§164.410 Business-Associate breach notice** — no template models the BA→covered-entity handoff, and `fillIncidentTemplate` has no production caller (§9.3).
15. **Contingency plan / DR drills** — no backup-restore script, no `aws_backup_plan`, no dated drill, no emergency-mode plan (§8). §164.308(a)(7)
16. **Right of access (§164.524) and amendment (§164.526)** — only erasure is implemented. There is no designated-record-set export, no 30-day access-request workflow and no amendment/denial/statement-of-disagreement machinery. Nor is there an accounting of disclosures (§164.528): `activity_logs` can now be filtered by subject, but sub-processor disclosures are not written to it.
17. **Raw diagnosis in live-agent prompts** — **RESOLVED 2026-09-14.** No agent in an AAC session reads a report or a diagnosis: the diagnosis loader is deleted and the report memory fields are gone from the session schema. Reports reach a session only as the audited, diagnosis-free report digest described in §2.2 (`server/services/aac/report-digest.ts`).

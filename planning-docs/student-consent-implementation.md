# Student Consent System — Implementation Reference

This document describes the consent / permission-gating system as actually built. It is the as-shipped counterpart to `student-consent-onboarding-plan.md`. For each feature it names the exact files, tables, endpoints, and tests that implement it, and maps each piece of gating back to the legal requirement it serves.

Last refreshed after building: AI memory-schema gating, AAC session termination, LicenseForm UI, Phase 3 magic-link flow (clinician → parent without account), admin consent-history UI, minor-threshold cron.

Companion docs:
- `planning-docs/student-access-permission-laws.md` — the legal requirements input.
- `planning-docs/student-consent-onboarding-plan.md` — the design plan (some details have evolved during build).
- `planning-docs/cross-institute-sharing-plan.md` — the sharing system this consent layer interacts with.

---

## 1. Scope and posture

The consent system has two responsibilities:

1. **Capture an informed-consent record per student** with full evidentiary chain — who signed, what they were told, what version of the legal notice they saw, what they opted into, how their identity was verified.
2. **Gate PHI-touching operations** so a student in a `consent_pending` state cannot have their data finalized, shared, or fed into an AAC session.

The system is built behind the `CONSENT_GATE_ENABLED` env flag (default off). Schema, services, API, wizard, and gate wiring all ship; flipping the flag activates blocking. A 90-day legacy grace window protects existing students against day-zero lockout.

Where the legal requirements are jurisdiction-specific, the schema stores country/regime as **text**, not enum. Adding support for a new country is data, not migration.

---

## 2. Database schema

### 2.1 New table — `student_consent_records`

Defined in `shared/schema-private.ts:1349`. One row = one signed consent transaction. Multiple rows per student over time (re-consent on text-version bump or post-revocation re-sign); the `idx_consent_records_active` partial index isolates the at-most-one row with `revoked_at IS NULL`.

Columns and what they enforce legally:

| Column | Purpose | Legal anchor |
|---|---|---|
| `country` (text, frozen) | ISO 3166-1 alpha-2 captured at sign time. Drives the regime even if `students.country` later changes. | All regimes apply by jurisdiction at point of collection. |
| `age_at_signing_years` | Student age when consent was signed, frozen. | COPPA / GDPR Article 8 / IL Legal Capacity Law all key off age. |
| `is_minor_enhanced_protection` + `enhanced_protection_regime` | Frozen result of the per-country adapter. Regimes: `us_coppa`, `eu_gdpr_minor`, `uk_ico_under13`, `il_general`, `gdpr_superset_default`. | COPPA / GDPR-minor / UK ICO age-appropriate design code / IL guardianship law. |
| `consent_text_version` + `consent_text_hash` | Versioned identifier + SHA-256 of the exact rendered notice. | PPA position paper (Feb 2026) — we must be able to reproduce what the parent saw. |
| `purpose_acknowledged` / `voluntariness_acknowledged` / `third_party_transfers_acknowledged` | Three required disclosures; UI submission must be true. | PPL §11 (IL), GDPR Art. 13/14, COPPA "direct notice". |
| `third_party_recipients` (jsonb, frozen) | Snapshot of recipient categories at sign time. Server-trusted. | "Data Transfers" disclosure obligation. |
| `opt_in_model_training` / `opt_in_advertising` / `opt_in_third_party_research` / `opt_in_marketing_comms` | All default false. Forced false when regime requires (us_coppa / eu_gdpr_minor / uk_ico_under13 / gdpr_superset_default). | COPPA 2025/2026 amendments (opt-in not opt-out for non-essential uses). |
| `opt_ins_forced_off` | Sentinel for audit — distinguishes parent-chose-no from regime-mandated-no. | Future re-consent on age-out should re-prompt rather than inherit forced state. |
| `identity_verification_method` + `identity_verification_evidence` | Free-text method id + jsonb evidence. | PPA Feb-2026: identity verification is required for sensitive medical consent. |
| `non_repudiation_method` + `non_repudiation_evidence` | Same shape, separate leg. | PPA Feb-2026: non-repudiation must be provable independently of identity. |
| `signed_at` / `signed_from_ip` / `signed_from_user_agent` | When and from where. | Standard audit. |
| `revoked_at` / `revoked_by_user_id` / `revocation_reason` | Withdrawal of consent (does not delete data). | All regimes grant revocation rights. |

### 2.2 `student_contacts` extensions

Defined in `shared/schema-private.ts:541`. Nine new columns:

| Column | Purpose |
|---|---|
| `government_id_number`, `government_id_type` (enum), `government_id_country` | Identity capture. Type is a generic enum (`national_id` / `passport` / `driver_license` / `other`); country code disambiguates. |
| `government_id_verified_via` (enum: `manual_entry` / `gov_sso` / `third_party_idv`) | How the ID was verified. |
| `government_id_verification_provider` (text) | Free-text provider tag (e.g. `moe_sapakim_il`, `admin_attested`, `self_declared`). Adding a provider = data not migration. |
| `government_id_verified_at` | Timestamp. |
| `is_legal_guardian` (default false) | The parent's "I am the legal guardian" declaration. Only contacts with this true can sign consent. |
| `co_guardian_acknowledged` (default false) | Parent attests that they have authority to consent on behalf of any other guardians (separated parents, kinship). |
| `legal_guardian_declared_at` | Timestamp the declaration was made. |

### 2.3 `student_share_invites` — `legal_basis`

Added to `shared/schema-private.ts:1731`. Enum: `guardian_consent` (default), `institutional_delegate` (FERPA "school official" / GDPR processor / HIPAA business associate equivalent), `formal_release_of_information`. The default keeps the existing flow conservative.

### 2.4 New table — `consent_invitations`

Defined in `shared/schema-private.ts` (added after the consent-records table). Token-based magic-link sent to a parent without a user account. The token IS the auth — see `consentInvitationService`.

| Column | Purpose |
|---|---|
| `student_id`, `contact_id`, `source_institute_id` | What the token is for. |
| `code_hash` | SHA-256 of the 12-char plaintext code. Plaintext is shown to the clinician once. |
| `created_by_user_id`, `channel` (`email`/`sms`/`manual`), `sent_to` | Audit fingerprint. |
| `expires_at` | Default 7 days. Refused once elapsed. |
| `redeemed_at`, `signed_consent_id` | Set when the parent successfully signs. FK back to the resulting `student_consent_records` row. |
| `revoked_at`, `revoked_by_user_id` | Clinician can cancel a pending invitation. |

Migration: `0087_fixed_cerise`.

### 2.6 `students.legacy_consent_deadline`

Added in migration `0086_milky_thundra`. Existing rows backfilled with `now() + 90 days`; new rows default null (must collect consent before PHI ops). Gate honors this window for legacy students only.

### 2.7 `users` — phone fields

Added in migration `0084`. `phone` (E.164), `phone_verified_at`. General profile use beyond consent (security alerts, MFA fallback, future SMS OTP).

### 2.8 Activity log enum extensions

In `shared/schema-private.ts:249,262`:
- New `activity_event_type` values: `consent_signed`, `consent_revoked`, `consent_re_signed`, `guardian_id_verified`, `minor_threshold_crossed`.
- New `activity_subject_type` value: `consent_record`.

---

## 3. Per-country legal adapters — `shared/legal/`

Pure-data modules; no DB access. The service layer consults these at every consent transaction.

### 3.1 `minor-protection.ts`

`resolveMinorProtection(country, ageYears) → { isApplicable, regime, forcedOffOptIns }`.

Per-country rules:

| Country | Threshold | Regime | Forced-off opt-ins |
|---|---|---|---|
| US | < 13 | `us_coppa` | All four |
| GB | < 13 | `uk_ico_under13` | All four |
| IL | < 18 | `il_general` | None (parent has authority under guardianship law) |
| EU member states | < 16 | `eu_gdpr_minor` | All four |
| Anything else | < 16 | `gdpr_superset_default` | All four |

`computeAgeYears(birthDate, asOf)` — month-and-day-aware year-of-life calculation.

### 3.2 `idv-methods.ts`

Eight identity-verification methods, each declaring which **regime contexts** accept it:

| Method | il_sensitive | us_coppa | eu_gdpr_art9 | standard | Provides both legs |
|---|---|---|---|---|---|
| `authenticated_session` | — | — | — | ✓ | ✓ |
| `gov_sso` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `third_party_idv` | ✓ | ✓ | ✓ | ✓ | — (must pair) |
| `in_person_clinician_attested` | ✓ | — | ✓ | ✓ | ✓ |
| `video_session_recorded` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `verified_phone_otp` | ✓ | — | — | ✓ | ✓ |
| `signed_form_upload` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `credit_card_match` | — | ✓ | — | — | ✓ |

`resolveIdvRegimeContext({ country, minorRegime, isSensitive })` picks the regime context for a given consent transaction.

`checkIdvAcceptability({ identityMethod, nonRepudiationMethod, regime })` validates the pair and returns one of: `unknown_identity_method`, `unknown_non_repudiation_method`, `identity_method_not_accepted_for_regime`, `non_repudiation_method_not_accepted_for_regime`, `identity_method_lacks_non_repudiation_pairing`, or `acceptable: true`. Methods are stored as text; adding a method is data, not migration.

### 3.3 `consent-notices/`

Per-country, per-locale, per-version notice text. Hash is computed deterministically over `title + purposeStatement + voluntarinessStatement + thirdPartyTransfersStatement + retentionStatement + rightsStatement` (joined with `\n---\n`) so two equivalent variants always hash identically.

Initial content:
- `IL.2026.04` in `en` and `he` (full translations).
- Other locales fall back to `en` at lookup time. Other countries return undefined — sign attempts for those countries fail at the `notice_not_found` boundary by design.

`lookupConsentNotice({ country, locale, version? })` resolves the active version when version is omitted. `renderNoticeForHashing(content)` produces the canonical string.

### 3.4 `recipients.ts`

`DEFAULT_RECIPIENTS` — categorized list (cloud_hosting / llm_provider / tts_provider / auth_provider / sub_processor) of third-party recipients disclosed at sign time. Server-trusted; the wizard renders what the server returns and cannot inject its own recipients.

---

## 4. Server-side service layer

### 4.1 `consentService.signConsent(input)` — `server/services/consent/consentService.ts`

Validation steps, in order:

1. All three disclosure acks must be true → `disclosures_required`.
2. Student must exist → `student_not_found`.
3. Student must have `birthDate` → `student_missing_birth_date`. (Country defaults to IL when null.)
4. Contact must exist, belong to the student, and have `isLegalGuardian = true` → `contact_not_found` / `contact_not_for_student` / `contact_not_legal_guardian`.
5. Notice variant must exist for the (country, locale, version) → `notice_not_found`.
6. Resolved version must match the submitted version → `notice_version_mismatch`.
7. Server-rendered hash must match the submitted hash → `notice_hash_mismatch` (defends against UI/server drift — the parent's UI must have rendered exactly what the server rendered).
8. IDV methods must be known → `idv_unknown_method`.
9. Method pair must be acceptable for the resolved regime context → `idv_not_acceptable`.
10. Apply opt-in forcing per regime; flip `optInsForcedOff` if any UI-on toggle was forced off.
11. Insert the consent record (server overwrites recipients with `getDefaultRecipients()` regardless of input).
12. Fire `consent_signed` activity log entry.

### 4.2 `consentService.revokeConsent`

Non-fatal cascade after the consent row is marked revoked: calls `studentShareInviteService.cascadeRevokeAllForStudent` to revoke every active object_share / standing_share for the student. Each per-grant revoke logs its own `share_revoked` / `standing_share_revoked` entry tagged with `details.cascade_reason: 'consent_revoked'`. Cascade failures are logged but don't roll back the consent revocation — the consent withdrawal is the legally binding act.

### 4.3 Other consent-service methods

- `getActiveConsent(studentId)` / `hasActiveConsent(studentId)` — null when none active.
- `getActiveConsents(studentIds[])` — batch lookup, used for list endpoints.
- `listHistory(studentId)` — full audit history including revoked rows.

### 4.4 Repository — `server/repositories/studentConsentRecordRepository.ts`

`create`, `getById`, `getActiveForStudent`, `getActiveForStudents` (batch), `listHistoryForStudent`, `revoke`. The active-row lookup orders by `signedAt desc` so even if multiple unrevoked rows exist (concurrency anomaly) the most recent wins.

### 4.5 SMS service — `server/services/smsService.ts`

Pluggable provider abstraction (`SmsProvider` interface) selected by `SMS_PROVIDER` env var:

- `console` (default) — logs the message body, returns success. Used in dev/test and as the no-op when SNS isn't configured yet.
- `sns` — AWS SNS Publish API. Uses `SMS_AWS_REGION` (falls back to `AWS_REGION`), optional `SMS_SENDER_ID` for non-US destinations, and `SMS_DEFAULT_CLASS` (default `Transactional`) for the SMS class. OTP messages always use the resolved class; bulk notification calls (`category: 'notification'`) downgrade to `Promotional`.

`sendOtp(to, code)` dispatches a fixed-format OTP body (10-min expiry, no-share warning).

`isVerificationBypassEnabled()` returns true when `SMS_VERIFICATION_BYPASS=true` and `NODE_ENV !== 'production'`. The phoneOtpService consults this and, when bypass is active, accepts the literal code `000000` without round-tripping a real SMS. Bypass signs must record `nonRepudiationEvidence: { bypassed: true, reason: 'sms_not_configured' }` for auditability.

### 4.6 Phone OTP layer — `server/services/phoneOtpService.ts` + `server/repositories/phoneOtpCodeRepository.ts`

Short-lived 6-digit OTPs scoped to `(purpose, scopeId, phone)`. The consent magic-link flow uses `purpose='consent_invitation'` and `scopeId=invitations.id`. Lifecycle:

1. `request({ phone, purpose, scopeId })` — generates a code, stores its sha256, dispatches via `smsService.sendOtp`, records the provider message id.
2. `verify({ phone, purpose, scopeId, code })` — looks up the active row, checks attempts (max 5) and expiry (10 min), marks consumed.
3. `getRecentlyVerified({ phone, purpose, scopeId, freshnessMs? })` — returns the most recent consumed row within the freshness window (default 15 min). Sign endpoints consult this rather than re-verifying.

Storage: `phone_otp_codes` table (migration `0088_rich_scarlet_witch`). Per-scope rate limit: 5 requests per 10-minute window. Plaintext codes are never stored.

---

## 5. API surface — `server/controllers/consentController.ts`

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/consent/notice?country=&locale=[&version=]` | Returns notice content + computed hash + recipient list. |
| GET | `/api/consent/students/:studentId/active` | Active consent record or null. |
| GET | `/api/consent/students/:studentId/wizard-context` | Bundle: student basics + current user + their guardian-contact for this student + active consent (if any). Prefill payload for the wizard. |
| POST | `/api/consent/students/:studentId/sign` | Updates the guardian contact (sets `isLegalGuardian=true`, applies co-guardian ack, gov-ID fields, `legalGuardianDeclaredAt`) AND writes the consent record in the same handler. |
| POST | `/api/consent/:consentId/revoke` | Permission-gated: only the contact's linked user OR a system admin can revoke. |

ConsentError → HTTP mapping in the controller: `student_not_found`/`contact_not_found`/`consent_not_found`/`notice_not_found` → 404; `contact_not_for_student` → 403; `contact_not_legal_guardian`/`idv_not_acceptable` → 422; `disclosures_required`/`student_missing_birth_date`/`idv_unknown_method` → 400; `notice_version_mismatch`/`notice_hash_mismatch`/`consent_already_revoked` → 409.

Permission checks at the controller layer (in addition to service-layer legal validation):
- `signConsent`: only the linked user of the contact can sign as that contact (`contact_not_owned_by_caller` → 403).
- `revokeConsent`: only the contact's linked user OR a system admin can revoke (`permission_denied` → 403).

Routes registered in `server/routes.ts:438–451`.

---

## 6. UI — clinician client

### 6.1 React Query hooks — `client/src/hooks/useConsentApi.tsx`

`useConsentNotice`, `useConsentWizardContext`, `useActiveConsent`, `useSignConsent`, `useRevokeConsent`. Mutations invalidate `consent-active` and `consent-wizard-context` keys.

### 6.2 The wizard — `client/src/features/consent/ConsentWizard.tsx`

Five steps:

1. **Identity** — read-only display of student + signing parent (from wizard-context).
2. **Guardian** — government-ID fields (type / country / number) + the co-guardian declaration checkbox. Prefilled from the auto-created contact + license inviteDefaults.
3. **Notice** — scrollable rendering of the active notice plus the recipient list, with three required acknowledgement checkboxes (purpose / voluntariness / transfers). "Next" disabled until all three are ticked.
4. **Opt-ins** — four switches, all default off. Wizard does not surface forced-off semantics yet (server forces them at sign time when regime requires).
5. **Review** — summary card and the Sign Consent button. Submission posts to `POST /api/consent/students/:studentId/sign` with v1 family-flow defaults: `identityVerificationMethod = nonRepudiationMethod = 'authenticated_session'`, `isSensitive: false` (standard regime context).

### 6.3 Wizard entry points

- **`StudentModal`** (`client/src/components/StudentModal.tsx`) — when a family-institute admin successfully creates a student, the wizard opens automatically against the new student id. Closing the wizard closes the modal.
- **`StudentInfoPanel`** — amber banner appears whenever `useActiveConsent` returns null. "Sign consent" button reopens the wizard. Safety net for any path that bypassed the auto-launch.

### 6.4 i18n

~50 keys under `consent.wizard.*` and `consent.notice.*` plus `bannerDescription` / `openButton`. All 11 locale files have the keys (`en` and `he` with proper translations; `ar`/`de`/`es`/`fr`/`ko`/`pt`/`ru`/`yue`/`zh` with English placeholders per the project's existing fallback pattern). Validator: 0 errors.

---

## 7. Permission gating — what the gate blocks

### 7.1 The gate helper — `server/services/consent/consentGate.ts`

Three exports:
- `requireActiveConsent(studentId)` — throws `ConsentGateError` when blocking. Honors the `CONSENT_GATE_ENABLED` env flag (no-op when unset). Honors the legacy grace window (passes if `students.legacy_consent_deadline > now`).
- `getConsentSnapshot(studentId)` — returns a frozen view of the active record's disclosures + opt-ins, or null. Used by AI-processing decisions to decide whether optional-use opt-ins are set. Always reflects current state regardless of flag.
- `requireConsentForResponse(req, res, studentId)` — Express helper. Returns true to proceed, false (after writing 412 + `consent_required`) to abort.

### 7.2 Wiring map — what the gate is plumbed into today

| Entry point | Wired in | Behavior when blocked |
|---|---|---|
| Cross-institute share-invite create | `studentShareInviteService.createInvite` | Throws `ShareInviteError("consent_required")` → HTTP 412 from `shareInviteController`. |
| AAC live session start | `dualAgentService.initializeSession` (first statement) | `live-relay` catches `ConsentGateError`, sends `error:CONSENT_REQUIRED` over the WS so the AAC client can distinguish from generic init failures. |
| Medical-record finalize | `reportController.finalizeMedicalRecord` (after access + ownership checks) | 412 `consent_required`. |
| Functional-report finalize | `reportController.finalizeFunctionalReport` | 412 `consent_required`. |
| Educational-report finalize | `reportController.finalizeEducationalReport` | 412 `consent_required`. |
| Program activate | `programController.activateProgram` | 412 `consent_required`. |
| Incident memory write (AI tool) | `incident-memory-schema.ts` `add` / `update` / `delete` ops | Throws `ConsentGateError`; the tool result surfaces an AI-readable message that names the cause and points to the consent wizard. |
| Report memory write (AI tool) | `reports-memory-schema.ts` `medicalRecordWriteOp` / `functionalReportWriteOp` / `educationalReportWriteOp` | Same. |
| Program memory write (AI tool) | `progress-memory-schema.ts` `programOps.write` | Same. |

Drafts can still be saved on all the above — only the transition to a final / live / shared state is gated.

### 7.3 AI awareness layer

The AI shouldn't produce confused tool failures when blocked. Two pieces:

- **Error message is AI-readable.** `ConsentGateError.message` says: *"Cannot access or modify this student's data: no active informed-consent record exists for the student (id=…). Ask the user to complete the consent wizard for this student before retrying."* When a memory-schema op throws, this message reaches the AI as the tool error.
- **Prompt-level pre-warning.** `sessionService.getMessageManager` calls `getConsentStatus(studentId)` and appends a `[CONSENT STATUS]` block to `template.corePrompt`. Three variants: gate off → no injection; active → "PHI ops permitted"; legacy grace → soft note with the deadline; consent pending → strong warning naming what will fail and the user-facing CTA. The AI sees this at session-init and can explain blocked operations to the user without confusion.

### 7.4 What is *not* gated (deliberately)

- **Reading basic identity** (name, age) — needed by the wizard itself; treating directory-level info as gated would create a chicken-and-egg.
- **Editing `student_contacts`** — needed for the consent flow itself.
- **Creating consent records** — by definition.
- **Drafting programs / records** — clinicians shouldn't lose work; only the final-state transition gates.

### 7.5 Cascade revocation

Three-prong cascade fires from `consentService.revokeConsent` after the consent record is marked revoked:

1. **Per-object & standing shares** — `studentShareInviteService.cascadeRevokeAllForStudent` lists every active grant for the student and revokes each via the existing single-grant methods. Each per-grant revoke fires its own audit entry tagged `details.cascade_reason='consent_revoked'`. Callers pass `extraDetails` to distinguish cascade from one-off revocations.
2. **Active AAC sessions** — `dualAgentService.terminateSessionsForStudent` iterates the in-memory session cache, fires the registered `onTerminate` callback (LiveRelay sends `error:CONSENT_REVOKED` and closes the WebSocket cleanly), evicts the cache entry, logs an `update` activity event with `details.action='aac_session_terminated'`. Lazy-imported to keep the dual-agent module chain out of consent-only test runs.
3. **Re-consent at age-out** — `runMinorThresholdCheck` daily cron (see §7.6) does NOT auto-revoke; it just emits `minor_threshold_crossed` events for human follow-up.

Cascade failures are logged but non-fatal — the consent withdrawal is the legally binding act and must complete even if downstream cleanup partially fails.

### 7.6 Minor-threshold cron

`server/services/consent/consentThresholdCron.ts`. `runMinorThresholdCheck` joins `student_consent_records` with `students`, filters to active rows where `enhanced_protection_regime` is set, computes current age vs. the regime's threshold (from `shared/legal/REGIME_THRESHOLDS`), and emits `minor_threshold_crossed` activity events for each newly-crossed transition. De-dup is via the activity log itself — already-flagged transitions are skipped on subsequent runs.

`scheduleMinorThresholdCheck` is invoked from server bootstrap; it sets a 30-second deferred initial run + a 24-hour `setInterval`. No-op in tests so suites can drive it directly.

5 tests in `server/tests/integration/consent-threshold-cron.test.ts`.

---

## 8. Audit trail

Activity log entries written by the consent system:

| Event | Subject1 | Subject2 | Details (representative) | Fired by |
|---|---|---|---|---|
| `consent_signed` | `consent_record` (id) | `student` (id) | `country`, `regime`, `consentTextVersion`, IDV methods, opt-ins, `signedByContactId` | `consentService.signConsent` |
| `consent_revoked` | `consent_record` (id) | `student` (id) | `reason`, `priorVersion`, `priorRegime` | `consentService.revokeConsent` |
| `share_revoked` (cascade) | `student` (id) | `share_invite` (id) | `scope: 'object_share'`, `objectShareId`, `objectType`, `cascade_reason: 'consent_revoked'` | cascade path |
| `standing_share_revoked` (cascade) | `student` (id) | `share_invite` (id) | `standingShareId`, `cascade_reason: 'consent_revoked'` | cascade path |

Events allocated but not yet emitted: `consent_re_signed`, `guardian_id_verified`, `minor_threshold_crossed`. These are reserved for re-consent and the age-out cron when those are built.

---

## 9. Feature flags and rollout

### 9.1 `CONSENT_GATE_ENABLED`

Off by default. When unset / `"false"`, the entire gate is a no-op — all entry points behave identically to before the consent system shipped. Setting `CONSENT_GATE_ENABLED=true` activates blocking at every wired entry point at once. Designed to be flippable without code change; the legacy grace window provides the runway to flip it.

### 9.2 `SMS_PROVIDER` / `SMS_VERIFICATION_BYPASS`

`SMS_PROVIDER` selects the SMS backend: `console` (default — logs only, used in dev/test) or `sns` (AWS SNS Publish). The SNS provider reads `SMS_AWS_REGION` (falling back to `AWS_REGION`), optional `SMS_SENDER_ID`, and `SMS_DEFAULT_CLASS` (`Transactional` by default). Adding more providers (Twilio/Vonage/etc.) is implementing `SmsProvider` and switching on the env value.

`SMS_VERIFICATION_BYPASS=true` lets the consent flow accept phone-OTP signs without round-tripping a real code (literal code `000000` is accepted); production refuses to honor the flag (`NODE_ENV === 'production'` short-circuit). Bypassed signs must tag `nonRepudiationEvidence: { bypassed: true, reason: 'sms_not_configured' }`.

### 9.3 Legacy grace window

`students.legacy_consent_deadline` was backfilled with `now() + 90 days` for every existing row by migration `0086_milky_thundra`. New rows default null. The gate passes for any student with a future deadline and no active consent. Admins can extend per-student deadlines (the field is writable). After the deadline, behavior is identical to a brand-new student with no consent — the gate blocks.

---

## 10. Mapping back to legal requirements

### 10.1 Israel — Privacy Protection Law §11 + Legal Capacity Law

- **Guardian consent for minors under 18** — student under 18 with `il_general` regime; only `student_contacts.is_legal_guardian = true` rows can sign; `coGuardianAcknowledged` captures dual-guardian situations.
- **Section 11 informed-notice content** — `IL.2026.04` notice text covers purpose, voluntariness, third-party recipients, retention, rights. Hash captured per-sign.
- **PPA Feb-2026 evidentiary requirements** — `identityVerificationMethod` + `nonRepudiationMethod` columns; method registry defines which methods are acceptable for `il_sensitive` context.
- **Right to revocation** — `revokeConsent` endpoint; cascade tears down active shares.

### 10.2 US — FERPA + COPPA

- **COPPA under-13 protections** — `us_coppa` regime forces opt-ins off regardless of UI submission. Method registry restricts COPPA to enumerated VPC methods (`signed_form_upload`, `credit_card_match`, `video_session_recorded`, `gov_sso`, `third_party_idv`); `verified_phone_otp` is rejected for COPPA contexts.
- **2025/2026 amendments** — opt-ins default off; advertising / training / research / marketing each independently controlled; the service must function fully with all four off.
- **FERPA "school official" exception** — `share_legal_basis` enum has `institutional_delegate` for the regime-neutral version. Default `guardian_consent` is conservative.

### 10.3 EU — GDPR

- **Article 8 minor consent** — `eu_gdpr_minor` regime triggers per EU member state list at age < 16.
- **Article 9 special-category data** — `eu_gdpr_art9` IDV regime context required for sensitive medical data; method registry restricts acceptable IDV.
- **Article 13/14 informed-notice** — covered by the same notice structure (purpose / voluntariness / recipients / retention / rights / contact).

### 10.4 Cross-jurisdiction

- **Data-controller obligations independent of authentication mechanism** — the PPA explicitly stated MoE SSO doesn't discharge the Section 11 notice. The system collects the notice every time regardless of auth path; gov-SSO populates only the `governmentIdVerifiedVia: 'gov_sso'` evidence field, never the notice itself.
- **Versioned notice + recipient snapshot** — when the recipient list changes, version bumps; existing consents remain valid only for what they explicitly disclosed.
- **Frozen jurisdiction at sign time** — students.country can later be edited; the consent record's `country` and `regime` stay as they were.

---

## 11. What is NOT yet implemented

These are deliberately deferred and currently absent:

- **Stronger IDV flows** — the wizard implements `authenticated_session` (family path, standard regime) and `verified_phone_otp` (magic-link path). Clinic-side flows that need stronger evidence — in-person clinician attest with photo capture, recorded video session, third-party IDV vendor (IDnow / Stripe Identity / Onfido), gov SSO (MoE Sapakim, login.gov) — need their own UI components and evidence-capture paths.
- **Real SMS provider** — `server/services/smsService.ts` ships with a `ConsoleSmsProvider` that logs instead of sending. Picking a provider (Twilio, Vonage, MessageBird) is implementing `SmsProvider` and switching on the env value.
- **Phone OTP layered on top of magic link** — the magic-link flow currently treats the link click as both legs. Adding an SMS OTP requirement (clinician sends link → parent clicks → enters code from SMS) would harden the non-repudiation leg further.
- **Consent-text legal review** — `IL.2026.04` text is a paraphrased draft. Final wording for production should go through a licensed Israeli privacy attorney; same applies to any new country variant.
- **Per-country consent notices beyond IL** — `lookupConsentNotice` returns undefined for any country other than IL. Add `US`, `EU`, `GB`, etc. variants under `shared/legal/consent-notices/` as deployment expands.
- **Admin activity-log UI extensions** — `minor_threshold_crossed` events flow into the standard activity log but the existing admin dashboard's filter dropdown doesn't yet include the consent event types as named options.

---

## 12. File reference

### Schema and migrations
- `shared/schema-private.ts` — enums, `studentContacts` extensions, `studentConsentRecords` + `consentInvitations` tables, `studentShareInvites.legalBasis`, `students.legacyConsentDeadline`, activity-log enum extensions, insert schema.
- `drizzle/0084_mighty_daredevil.sql` — `users.phone`, `users.phone_verified_at`.
- `drizzle/0085_charming_sentinels.sql` — consent enums, contact extensions, consent-records table, share-invite legal-basis, activity-log values.
- `drizzle/0086_milky_thundra.sql` — `students.legacy_consent_deadline` + 90-day backfill.
- `drizzle/0087_fixed_cerise.sql` — `consent_invitations` table.

### Server-side
- `shared/legal/types.ts` / `minor-protection.ts` (incl. `REGIME_THRESHOLDS`) / `idv-methods.ts` / `recipients.ts` / `consent-notices/` / `index.ts` — adapter layer.
- `server/repositories/studentConsentRecordRepository.ts` / `consentInvitationRepository.ts` — DB layer.
- `server/services/consent/consentService.ts` — sign/revoke/lookup; cascade share-revoke + AAC session termination on revoke.
- `server/services/consent/consentInvitationService.ts` — magic-link create / redeem / sign-with-token / revoke.
- `server/services/consent/consentGate.ts` — `requireActiveConsent`, `getConsentSnapshot`, `getConsentStatus`, `requireConsentForMemoryWrite`, `requireConsentForResponse`, `ConsentGateError`.
- `server/services/consent/consentThresholdCron.ts` — `runMinorThresholdCheck` + scheduler.
- `server/services/consent/guardianContactAutoCreate.ts` — auto-create guardian contact on first family-institute student.
- `server/services/smsService.ts` — pluggable SMS provider with bypass flag.
- `server/services/sharing/studentShareInviteService.ts` — `cascadeRevokeAllForStudent`, `revokeObjectShare`/`revokeStandingShare` extended with `extraDetails`.
- `server/repositories/shareInviteRepository.ts` — `listAllActiveSharesForStudent`.
- `server/services/dual-agent/dual-agent-service.ts` / `live-relay.ts` — gate at AAC session start; `terminateSessionsForStudent`; `injectTestSession`; `onTerminate` callback wiring.
- `server/services/sessionService.ts` — `formatConsentStatusForPrompt` + corePrompt injection.
- `server/services/memory-schema/incident-memory-schema.ts` / `reports-memory-schema.ts` / `progress-memory-schema.ts` — `requireConsentForMemoryWrite` at AI write boundaries.
- `server/controllers/consentController.ts` — HTTP surface (notice / wizard-context / sign / revoke / list-history / list-invitations / create-invitation / redeem-invitation / sign-invitation / revoke-invitation).
- `server/controllers/reportController.ts` / `programController.ts` — gate at finalize/activate paths.
- `server/controllers/licenseController.ts` + `server/services/licenseService.ts` — guardian-identity inviteDefaults plumbing.
- `server/index.ts` — calls `scheduleMinorThresholdCheck` at boot.
- `server/routes.ts` — `/api/consent/*` routes.

### Client-side
- `client/src/hooks/useConsentApi.tsx` — React Query hooks (notice / wizard-context / active / history / sign / revoke / pending-invitations / revoke-invitation / consent-invitation context / sign-with-token / create-invitation).
- `client/src/features/consent/ConsentWizard.tsx` — five-step wizard; supports both session-mode and token-mode.
- `client/src/features/consent/SendConsentRequestDialog.tsx` — clinician dispatch dialog (email / SMS / copy-link).
- `client/src/features/consent/PendingInvitationsList.tsx` — in-flight invitations + revoke.
- `client/src/features/consent/ConsentHistoryPanel.tsx` — collapsible audit-grade timeline + revoke active.
- `client/src/pages/ConsentSignPage.tsx` — public magic-link landing page (`/consent/sign?code=`).
- `client/src/components/StudentModal.tsx` — auto-launch wizard on family-institute student creation.
- `client/src/components/admin/LicenseForm.tsx` — guardian-identity prefill capture.
- `client/src/features/StudentInfoPanel.tsx` — banner + buttons + history.
- `client/src/App.tsx` — public route registration for `/consent/sign`.
- `client/src/i18n/*.ts` — 11 locales with `consent.wizard.*` / `consent.notice.*` / `consent.sign.*` / `consent.send.*` / `consent.pending.*` / `consent.history.*` / `admin.licenses.guardianIdentity.*` keys.

### Tests
- `server/tests/integration/consent.test.ts` — 11 service-layer tests.
- `server/tests/integration/consent-gate.test.ts` — 10 gate-helper tests.
- `server/tests/integration/consent-api.test.ts` — 11 controller tests.
- `server/tests/integration/consent-gate-wiring.test.ts` — 5 finalize/activate wiring tests.
- `server/tests/integration/consent-cascade-revoke.test.ts` — 2 cascade tests.
- `server/tests/integration/guardian-contact-auto-create.test.ts` — 6 auto-create tests.
- `server/tests/integration/consent-ai-gate.test.ts` — 9 memory-schema gate + status-snapshot tests.
- `server/tests/integration/consent-invitation.test.ts` — 9 invitation service tests.
- `server/tests/integration/consent-invitation-api.test.ts` — 7 invitation controller tests.
- `server/tests/integration/consent-threshold-cron.test.ts` — 5 cron tests.
- License test additions: `server/tests/integration/license.test.ts` covers guardian-identity inviteDefaults storage.
- `server/tests/helpers/http.ts` — fake req/res helpers (now with `.get()` stub for header-aware controllers).

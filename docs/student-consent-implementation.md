# Student Consent System — Implementation Reference

This document describes the consent / permission-gating system as actually built. It is the as-shipped counterpart to `student-consent-onboarding-plan.md`. For each feature it names the exact files, tables, endpoints, and tests that implement it, and maps each piece of gating back to the legal requirement it serves.

Last refreshed after building: **consent-gate coverage for the AI's student chat-memory, relationship notes and AAC settings** (2026-09-10, §7.2 / §7.4 — closes the last coverage hole: those writes were guarded by prompt text only); self-serve withdrawal for a signer with no user account (2026-09-10, §5.3 — closes the residual §11 item that attest parity left open); attest-parity revocation (2026-09-09, §5.2); in-person clinician-attested consent (2026-09-09, §5.1 / §6.2.1); before that AI memory-schema gating, AAC session termination, LicenseForm UI, Phase 3 magic-link flow (clinician → parent without account), admin consent-history UI, minor-threshold cron.

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
| `created_by_user_id`, `channel` (`email`/`sms`/`manual`), `sent_to` | Audit fingerprint. `created_by_user_id` is NULLABLE since 2026-09-10 — a guardian minting their own withdrawal token has no user account. |
| `expires_at` | Default 7 days; clamped to a 72h ceiling by the service. Refused once elapsed. |
| `redeemed_at`, `signed_consent_id` | Set when the parent successfully signs. FK back to the resulting `student_consent_records` row. On a `withdraw` row `redeemed_at` is stamped when the withdrawal commits and `signed_consent_id` stays null — that token creates nothing. |
| `revoked_at`, `revoked_by_user_id` | Clinician can cancel a pending invitation. |
| `id_verified_at`, `id_verify_attempts` | Email-channel child-ID knowledge gate, capped at 5 attempts. Used by both purposes. |
| **`purpose`** (`sign` \| `withdraw`, default `sign`) | ⚠️ **Security discriminator, added 2026-09-10.** What the token authorises. Every lookup filters on it: `loadActiveInvitationByCode(code, purpose)` refuses a mismatch as `code_not_found`, and `listPendingForStudent` defaults to `sign`. |
| **`target_consent_id`** | The consent record a `withdraw` token withdraws. Null on `sign` rows. The token is bound to a RECORD, not merely a student — a student may hold several records over time. |

**Why withdrawal reuses this table rather than adding one.** A withdrawal token needs 60-bit code generation, sha256-at-rest under a unique index, finite expiry, single-use redemption, clinician cancellation, an SMS-OTP scope id, and a brute-force-capped knowledge gate. All seven already exist here and are exercised by the sign flow; a `consent_withdrawal_tokens` table would be a second copy of every one of them, and the copy is what drifts. The row already discriminated on `recipient_type`, so a second discriminator is the shape this table was in. The cost is that a purpose filter is now load-bearing on every query — stated in the schema comment and pinned by two tests (a withdrawal token refused on `/invitations/sign`, and a sign token refused on `/withdraw/context`).

Migrations: `0087_fixed_cerise` (table), `0180_unknown_power_man` (`purpose`, `target_consent_id`, nullable `created_by_user_id`).

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

`create`, `getById`, `getActiveForStudent`, `getActiveForStudents` (batch), `listHistoryForStudent`, `listAttestedByUser` (every consent a given clinician attested in person — a jsonb query over `identity_verification_evidence->>'attestingClinicianUserId'`, named so an auditor need not know the key path), `revoke`. The active-row lookup orders by `signedAt desc` so even if multiple unrevoked rows exist (concurrency anomaly) the most recent wins.

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
| GET | `/api/consent/students/:studentId/wizard-context[?contactId=]` | Bundle: student basics + current user + their guardian-contact for this student + active consent (if any). Prefill payload for the wizard. Default path gated by `assertWizardContextAccess` — institute overlap **OR** a `student_contacts` row linked to the caller **OR** an active `user_students` link (2026-09-10; it was session-only before that). `?contactId=` names a contact the caller does NOT own (the in-person attest path) and stays on `assertStudentAccess` — institute overlap only, so the param cannot widen what the default path exposes. |
| POST | `/api/consent/students/:studentId/sign` | Updates the guardian contact (sets `isLegalGuardian=true`, applies co-guardian ack, gov-ID fields, `legalGuardianDeclaredAt`) AND writes the consent record in the same handler. |
| POST | `/api/consent/students/:studentId/attest-in-person` | **In-person clinician attestation** — see §5.1. |
| POST | `/api/consent/:consentId/revoke` | Permission-gated: the contact's linked user, a system admin, or — **for a clinician-attested record only** — anyone who could have attested it. See §5.2. |
| POST | `/api/consent/withdraw/request-link` | **PUBLIC**, no token. The receipt's reference URL. Always 200. See §5.3. |
| POST | `/api/consent/withdraw/context` | **PUBLIC**, token-authed. What the withdrawal page renders. |
| POST | `/api/consent/withdraw/request-otp` | **PUBLIC**, token-authed. SMS OTP, `purpose='consent_withdrawal'`. |
| POST | `/api/consent/withdraw/verify-otp` | **PUBLIC**, token-authed. |
| POST | `/api/consent/withdraw/verify-id` | **PUBLIC**, token-authed. Child-ID last-4, attempt-capped. |
| POST | `/api/consent/withdraw/confirm` | **PUBLIC**, token-authed. The withdrawal. Requires `confirm: true`. |
| POST | `/api/consent/:consentId/withdrawal-link` | Institute-admin. Re-issues a withdrawal link to the signer's stored channel. Caller never sees the code. |

ConsentError → HTTP mapping in the controller: `student_not_found`/`contact_not_found`/`consent_not_found`/`notice_not_found` → 404; `contact_not_for_student` → 403; `contact_not_legal_guardian`/`idv_not_acceptable` → 422; `disclosures_required`/`student_missing_birth_date`/`idv_unknown_method` → 400; `notice_version_mismatch`/`notice_hash_mismatch`/`consent_already_revoked` → 409.

Permission checks at the controller layer (in addition to service-layer legal validation):
- `getWizardContext` (default path): `assertWizardContextAccess` — institute
  overlap (`userSharesInstituteWithStudent`, system admins pass) **OR** a
  `student_contacts` row whose `linkedUserId` is the caller **OR** an active
  `user_students` link (`studentRepository.userHasAccessToStudent`). The union
  is not a guess at who the parents are: it is exactly the set `signConsent`
  admits (below) plus the institute readers, because a read gate narrower than
  the write it prepares would 403 a legitimate signer. That is why it could not
  simply join the 2026-09-09 `assertStudentAccess` sweep, and it is the reason
  it sat open — a family-account student may be enrolled in no institute at all.
  **The magic-link guardian is not one of these callers**: they hold no session
  and reach the wizard through the public `/invitations/redeem` +
  `/invitations/sign` pair, never this endpoint. The permission check runs
  before the student row is read, so an unpermitted caller cannot distinguish a
  real student id from an invented one. With `?contactId=` the endpoint stays on
  `assertStudentAccess` instead — a linked guardian who passes the default path
  is still refused when they name another person's contact row.
- `signConsent`: only the linked user of the contact can sign as that contact (`contact_not_owned_by_caller` → 403); on a self-consent student, an active `user_students` link instead.
- `attestInPerson`: any ACTIVE member of an institute the student is enrolled in (`attestPermissionFor`, wrapped by `assertAttestPermission`).
- `revokeConsent`: the contact's linked user, a system admin, or — **only** on a record whose `identityVerificationMethod` is `in_person_clinician_attested` — a caller satisfying `attestPermissionFor` (`permission_denied` → 403). See §5.2.
- `listHistory`: any institute member reads it, but each record carries a server-computed `canRevoke` from the same `revokePathFor` the revoke endpoint enforces, so the UI's affordance cannot disagree with the server's answer.

Routes registered in `server/routes.ts`.

**Rate limiting on the public surface (2026-09-10).** All eleven public,
token-authed routes — `/invitations/{redeem,sign,request-otp,verify-otp,
verify-id}` and the six `/withdraw/*` — carry `authRateLimiter` (10 req/min per
IP, 60 s window, self-skipping under `NODE_ENV=test`). The three
`/invitations/{request-otp,verify-otp,verify-id}` legs shipped without it and
were the last gap.

Be precise about what it buys, because the application caps are what actually
bound the guessing: `verify-id` locks the invitation after
`CHILD_ID_MAX_VERIFY_ATTEMPTS` (5) wrong last-4 guesses until a clinician
re-issues; `verify-otp` allows 5 wrong codes per OTP; `request-otp` allows 5
sends per 10 min per (purpose, invitation, phone) in `phoneOtpService`, and its
destination comes from the invitation's contact row, never from the request —
so it is not an uncapped SMS amplifier. Every one of those caps is keyed to a
resolved invitation, so none of them can see a request carrying a code that does
not exist; the per-IP limiter is the only thing metering that traffic (a sha256
plus an indexed select per request, unauthenticated). The code itself is 12
characters of a 31-symbol alphabet (~59 bits), so junk-code probing is a cost
problem, not a credential one. 10/min will not lock out a guardian who
fat-fingers a code — the 5-attempt application cap bites first, and the window
resets in a minute.

Wiring pinned at source level by `server/tests/consent-route-guards.test.ts`
(DB-free; a behavioural test is impossible because the limiter self-skips under
test), which also fails on any `/api/consent/*` route registered with neither
`requireAuth` nor `authRateLimiter`.

### 5.1 `POST /api/consent/students/:studentId/attest-in-person`

The clinic-desk consent: the guardian is physically present, the clinician has
inspected their identification, and the clinician records the consent from their
own authenticated session. Built 2026-09-09.

**Why a separate endpoint.** `/sign` refuses unless `contact.linkedUserId ===
caller`. That rule is correct for the parent flow and is unchanged. A clinic
guardian is a name and an email with no user account, so the parent rule can
never admit them, and loosening it would also admit every other caller who is
not the guardian. This endpoint accepts a contact the caller does not own
*precisely because the caller is not claiming to be the guardian* — they are
attesting, from their own identified session, that they saw one. Pinned by
`consent-attest-in-person.test.ts` ("leaves POST .../sign refusing an unlinked
contact, even for an institute member").

**The server owns the method.** `identityVerificationMethod` and
`nonRepudiationMethod` are both forced to `in_person_clinician_attested` from
the module-level `IN_PERSON_IDV_METHOD` constant. `attestInPersonSchema` has no
key for either, so zod strips a client-supplied value rather than honouring it.
This matters because the methods are not interchangeable: `gov_sso` and
`signed_form_upload` are accepted for `us_coppa` and this one is not, so a
client that could name its own method could claim a regime it did not earn.
`isSensitive` is likewise server-owned and forced `true` (a clinic recording an
in-person consent is collecting health data; the family flow's `false` would
under-state the regime).

**Legal pre-flight — and why it is not redundant.** The controller resolves
(country, age, sensitivity) → regime and calls `checkIdvAcceptability` *before*
touching anything. `signConsent` re-checks at step 9 and remains the authority;
the pre-flight exists because `signConsent` looks the consent notice up (step 5)
**before** the IDV check, and notices exist only for IL — a US under-13 would
fail `notice_not_found` and the COPPA rule would never be reached. The rule is
not re-implemented: the same adapter is called, so adding a country stays data.
The pre-flight also means a refused attestation cannot leave `isLegalGuardian`
flipped behind it.

**How `isLegalGuardian` is established.** The clinician's inspection, not the
guardian's own click. The record says so in three places:
`student_contacts.government_id_verification_provider = 'clinician_attested'`
(the parent flow writes `self_declared` in the same column),
`identity_verification_evidence.attestingClinicianUserId`, and the
`guardian_id_verified` activity row (§8).

**Evidence captured.**

| Leg | Contents |
|---|---|
| `identity_verification_evidence` | `attestingClinicianUserId` / `attestingClinicianName` / `attestingClinicianEmail`, `attestedAt`, `guardianPresent: true`, `identificationInspected: { type, country, numberOnFile }`, free-text `notes`, `signedByContactId` / `signedByContactName`, `provenance: 'in_person_clinician_attest'` |
| `non_repudiation_evidence` | `attestingClinicianUserId`, `attestedAt`, `ip`, `userAgent`, `signature` (the GUARDIAN's typed or drawn signature), `signedByContactId` |

The guardian's own signature is **required** on this path (`signature` is not
optional in the schema). The legal layer does not demand it — the plan lets the
clinician's session carry both legs alone — so this is a deliberate step above
the documented minimum: on this path the guardian never touches an authenticated
session of their own, and the signature is the only machine-captured act that is
theirs.

**Where the attesting clinician lives, and how to query it.**
`student_consent_records` has no `attested_by_user_id` column and does not gain
one: the consent plan specifies the attester's id as an evidence key, and the
schema comment on `identityVerificationMethod` is explicit that the jsonb
evidence pair is where method-specific evidence lives so that adding a method
stays data rather than a migration. jsonb is queryable
(`identity_verification_evidence->>'attestingClinicianUserId'`), and
`studentConsentRecordRepository.listAttestedByUser(userId)` is that query as a
named call so an auditor need not know the key path.

**Data minimisation.** The government-ID *number* is written to the contact row
(its one existing home) and deliberately **not** copied into the evidence jsonb.
`student_contacts.government_id_number` is stored in plaintext and un-masked at
the REST layer (SECURITY_ARCHITECTURE §1.3, an open finding); a second
un-redacted copy would widen that finding for no evidentiary gain. What was
inspected is recorded as document type + issuing country.

**Errors.** `permission_denied` → 403; `contact_not_found` → 404;
`contact_not_for_student` → 403; `signer_not_permitted` (student self-consents)
→ 422; `student_missing_birth_date` → 400; `idv_not_acceptable` → 422 with
`details.regime` / `details.reason` / `details.identityMethod`; then the normal
`signConsent` codes (`notice_not_found`, `notice_hash_mismatch`, …).

### 5.2 Revoking a clinician-attested consent — attest parity

Built 2026-09-09, immediately after §5.1, closing the gap that §5.1's build left
open on purpose.

**The gap.** `attestInPerson` signs as a guardian contact with **no
`linkedUserId`** — that absence is the entire reason the endpoint exists.
`revokeConsent`'s rule was "the signing contact's linked user, or a system
admin". A clinic-attested consent therefore had exactly ONE revoker anywhere in
the system: a system admin. Every regime this system implements grants a right
of withdrawal (§10.1 IL PPL §11, GDPR Art. 7(3), COPPA §312.6), so that was a
real hole, not a nicety.

**The rule.** *Attest permission = revoke permission.* Whoever could have
attested a consent may also revoke it.

**The scope, and why it is this narrow.** The rule applies **only** to a record
whose `identityVerificationMethod` is `in_person_clinician_attested`. The broad
reading — "any institute member may revoke any of that student's consents" — was
considered and **rejected**: it would let a clinic member tear up a consent a
parent signed themselves (session flow or magic link), taking a right away from
the person who actually holds it, and that is a much larger widening than the
one this closes. A parent-signed record's rules are byte-for-byte what they were.
Pinned by `consent-revoke-permission.test.ts` ("does NOT let the same member
revoke a record the parent signed themselves"), which is deliberately set on a
student the member **does** have institute access to, so it cannot pass for the
wrong reason.

**One predicate, not two.** The permission is `attestPermissionFor(req,
studentId)` in `consentController.ts` — literally the function the attest WRITE
gates on, including `ATTEST_REQUIRES_INSTITUTE_ADMIN`. Flipping that constant to
`true` tightens creation and withdrawal together; they cannot drift. The attest
endpoint calls it through `assertAttestPermission` (the response-writing wrapper
that owns the 401/403 statuses); the revoke path calls the predicate directly,
because on failure it must fall through to its own rules rather than answer.

**`revokePathFor(req, record[, attestGrant])`** is where all the revoke rules
live and returns *which* rule admitted the caller — `system_admin` | `signer` |
`attest_parity` | `null`. Order is `system_admin` (short-circuits before any
contact query, exactly as before) → `signer` (verbatim) → `attest_parity`, so a
record that was already revocable is admitted by the same rule and logged under
the same label as before this change. The optional `attestGrant` lets
`listHistory` resolve the parity predicate once per student instead of once per
row.

**`canRevoke` on the history response.** `GET .../history` admits any institute
member; most of them may not revoke most records. The endpoint therefore stamps
each record with `canRevoke` from the same `revokePathFor`, and
`ConsentHistoryPanel` renders the Revoke button only when it is true. Before
this, the button was offered to everyone who could see the panel and the server
answered 403 — a confident click and an error toast. The client treats an absent
flag as "not permitted".

**What it does NOT change.** The cascade (§7.5) is untouched and still fires on
this path — shares revoked, AAC sessions terminated, failures non-fatal.
`consentService.revokeConsent` gained one optional `extraDetails` argument
(merged into the audit row, same shape `studentShareInviteService` uses for its
cascade tag) and nothing else; the service still does not know or care which
rule admitted the caller.

### 5.3 Self-serve withdrawal — a signer with NO user account

Built 2026-09-10, closing the residual §11 item that §5.2 deliberately left open.
`server/services/consent/consentWithdrawalService.ts`.

**The gap.** `POST /api/consent/:consentId/revoke` requires a session and
resolves the caller through `studentContacts.linkedUserId`. A guardian who
signed by magic link — the NORMAL clinic path — has an email, a phone and no
`users` row, so that rule can never admit them. The sign token was consumed at
sign time (`redeemed_at` + `signed_consent_id`), so their link does not come
back. `/api/consent/invitations/:id/revoke` cancels a *pending invitation* and
is a clinician affordance. Net: a magic-link-signed consent was revocable by a
system admin and nobody else, while the receipt told the signer they could
withdraw "by contacting the clinic".

**Scope.** Every consent record whose signer has no account — that is
magic-link-signed AND in-person-attested guardian records (`signed_by_contact_id`
with a null `linked_user_id`), and also magic-link-**self**-signed records
(`signed_by_contact_id` null AND `signed_by_user_id` null), whose destination is
read off the originating invitation's `sent_to`. A signer who HAS a linked user
is refused (`withdrawal_not_available`): they already have the session path, and
minting them a token would add a second, weaker credential to an account that has
a password and MFA. Coverage is therefore total over token-signed records.

#### What the law actually says, and what is interpretation

Read off the rules:

- **`shared/legal/` imposes NO withdrawal-specific bar.** `idv-methods.ts` is a
  registry of what each regime accepts as an IDV method **for signing**;
  `minor-protection.ts` is about opt-in forcing and age thresholds;
  `consent-authority.ts` is about who may sign. None of the five regimes
  (`us_coppa`, `eu_gdpr_minor`, `uk_ico_under13`, `il_general`,
  `gdpr_superset_default`) carries a withdrawal clause, and neither does
  `planning-docs/student-access-permission/student-access-permission-laws.md`
  (grep for "withdraw"/"revoc" returns nothing).
- **`planning-docs/ministry-of-education-approval/` says nothing about it
  either.** `moe-plan.md`'s only consent references are the regime registry and
  the sub-processor list. `moe-status.md` F.2's *"self-service flow for institute
  admins (vs. system admin only) is out of scope for v1"* is about
  RIGHT-TO-ERASURE, a separate workflow (`studentErasureService`), and must not
  be generalised to consent withdrawal — the same warning §5.1 attaches to it.
- **The only thing the system has ever PROMISED a signer** is
  `IL_2026_04.rightsStatement`: withdraw "at any time … contact the clinic's data
  protection officer". Even that does not require self-serve.

Interpretation, flagged as such:

- **GDPR Art. 7(3) — "it shall be as easy to withdraw as to give consent" — is
  the whole reason this exists**, and applying it to mean *machine-driven
  withdrawal that does not depend on an employee's cooperation* is a reading, not
  a citation. It is the reading §11 already recorded, and it is the strictest
  bar any implemented regime plausibly imposes, so it is the one built to.
- **COPPA §312.6 arguably permits LESS.** It grants the parent a right to refuse
  further collection and does not extend the enumerated verifiable-parental-
  consent methods of §312.5(b)(2) to a revocation; FTC guidance has generally
  treated revocation as needing less rigour than consent. That latitude is
  **deliberately not taken** — see the bar below.
- **IL PPL §11 and the PPA Feb-2026 position paper** prescribe evidentiary
  requirements for the CONSENT, not for its withdrawal. The 72h link ceiling is
  carried over from the PPA's stale-link rule by analogy, again a reading.
- **No regime is stricter here than GDPR.** Nothing found imposes a bar this
  design fails to meet.

#### The security bar — equal in both directions

Not harder than signing, on the Art. 7(3) reading flagged above as an
interpretation rather than a citation. Not easier, or a forwarded
receipt email revokes a child's consent — and a withdrawal is not harmless: it
terminates the live AAC session of a child who depends on the device. The risk
asymmetry is real (a malicious withdrawal is a denial of service, not an
exfiltration) and it informs the *shape* — the confirmation page states
consequences plainly, the act is reversible by re-consenting — but it is not
taken as licence to skip verification.

Parity is achieved by **calling the same functions the sign flow calls**, never
by re-stating the rule:

| Channel | Signing gate | Withdrawal gate | Shared code |
|---|---|---|---|
| SMS | Phone OTP to `contactPhone`, `purpose='consent_invitation'` | Phone OTP to the same stored number, `purpose='consent_withdrawal'` | `phoneOtpService` |
| Email | Last-4 of the child's institute ID, **only when one is on file**, 5-attempt cap | Identical, same columns, same cap | `getChildInstituteIdNumber`, `normalizeIdLast4`, `CHILD_ID_MAX_VERIFY_ATTEMPTS` |
| Email, no ID on file | Token click alone | Token click alone | (same predicate returns null) |

The `token_only` case is parity, not a shortcut: it is reached exactly when the
sign flow would also have been token-only, and it is DERIVED from
`getChildInstituteIdNumber` rather than asserted. The OTP purposes are distinct
so a code verified for one act cannot satisfy the other.

**Channel choice prefers the stronger factor.** When the signer has both a phone
and an email on file the link goes by SMS, because SMS carries a real possession
factor while email's factor only exists when an institute ID happens to be
recorded. Without this preference the withdrawal bar could drift *below* the
signing bar for the same person.

**An attested record is a special case worth naming.** Its signing bar was
physical presence plus a clinician's inspection of identification. There is no
analogue to that at a distance, so its withdrawal bar is link + OTP. That is
plainly not *harder* than travelling to the clinic with a passport (Art. 7(3) is
satisfied), and it is a genuine two-channel proof rather than a click, so it is
not a downgrade to nothing either.

**Every token property required.** Single-use (`markWithdrawalRedeemed` is a
conditional update on "not yet redeemed", and it runs BEFORE the revoke so two
racing tabs produce one winner and one `code_already_used`); 72h expiry; sha256
at rest under a unique index; bound to `(target_consent_id, contact_id)` and not
merely to a student; second factor checked at the COMMIT, not merely offered, so
a client that skipped `/verify-*` cannot reach the revoke; every public route
carries `authRateLimiter`.

**Enumeration safety.** `request-link` always answers `200 {success: true}` —
for a real reference, a well-formed unknown UUID, and garbage alike. It reveals
nothing about whether the record exists, whether the student exists, whether the
signer has an account, whether a channel is on file, or whether the consent was
already withdrawn. A purpose mismatch on a token answers `code_not_found`, the
same non-answer a random string gets.

#### Delivery — how the link reaches the guardian, and the longevity trade-off

**The receipt carries a REFERENCE URL, not a token**:
`/consent/withdraw#ref=<consentId>`. Opening it asks the server to mint a fresh
72h single-use token and send it to the address already on file. This is the
password-reset shape: holding the reference buys exactly one thing — an email or
SMS to a destination you must already control.

The alternative — a live withdrawal token in the receipt — was **rejected**. The
receipt is a document the guardian is explicitly told to KEEP, potentially for
years, and may forward to a co-parent, a lawyer or a school; a token in it would
be a multi-year standing capability to terminate a child's AAC session, held by
everyone that email ever reached. It would also contradict a rule this codebase
already wrote down: `consentInvitationService` caps sign links at 72h precisely
so a stale link in an inbox cannot be redeemed later.

The consent record id is a `gen_random_uuid()` v4 (122 bits), so it is not
guessable — but the endpoint answers identically regardless, because
"unguessable" is a reason not to fear brute force, not a licence to answer
questions about the reference you were handed. A per-record 10-minute throttle
stops a replayed receipt from mailbombing the guardian's own inbox.

**Withdrawal-link TTL is 72h, the same ceiling as a sign link, and the equality
is deliberate**: a shorter window would make withdrawing harder than giving. A
shorter TTL was considered (the guardian requests the link seconds before they
need it) and rejected for that reason alone.

**The clinic can re-issue** (`POST /api/consent/:consentId/withdrawal-link`) for
the guardian who phoned or lost the email. Institute-admin gated, matching
`createInvitation` — the consent-sending affordance it mirrors — rather than the
looser `assertStudentAccess`, because this is a send rather than a read. It is
not a back door: the response carries only a masked destination, the clinician
never sees the code, and the link goes to the guardian's stored channel, so
§5.2's rule that a clinic member may not tear up a parent-signed consent stands
untouched. Surfaced in `ConsentHistoryPanel` behind a server-computed
`canSendWithdrawalLink` flag, the same "server owns the affordance" pattern as
`canRevoke`.

#### The page

`client/src/pages/ConsentWithdrawPage.tsx`, public route `/consent/withdraw`,
mirroring `ConsentSignPage` (fragment-borne value scrubbed from the address bar,
`noindex` meta, no provider dependencies).

🚨 **It never withdraws on load.** Email scanners, corporate link-rewriters and
browser prefetchers follow URLs; a one-click withdrawal link would let any of
them end a child's AAC session with no human involved. The page states the five
consequences before any button appears, gates the button behind a checkbox, and
the server independently refuses a confirm that does not carry `confirm: true`
(`z.literal(true)` — a payload without it is malformed, not "a withdrawal with
confirm=false"). Only the token RESOLUTION runs on mount, and that changes
nothing.

It uses `t()` only, deliberately not `ts()`: that helper lives on
`useStudentLabel`, which calls `useInstitute()`, and this page renders outside
every provider. Its copy is guardian-facing and says "your child" throughout,
matching the receipt and the sign page.

#### Errors

`code_not_found` → 404; `code_expired` / `code_already_used` / `code_revoked` →
410; `consent_not_found` → 404; `consent_already_revoked` → 409;
`withdrawal_not_available` → 403; `confirmation_required` → 400;
`phone_otp_required` / `child_id_verification_required` → 412;
`child_id_mismatch` → 422; `child_id_verify_locked` → 429;
`contact_missing_channel` → 400. All four new codes were added to
`ConsentInvitationErrorCode` and the ONE `invitationErrorStatus` map rather than
to a parallel taxonomy.

#### Null actor

The withdrawer has no `users` row, so `revoked_by_user_id` is NULL. Every
`revoked_by_user_id` column in the schema was already nullable and
`activityLogService.log` already took `userId?: string | null`; only the
TypeScript signatures asserted an account. Widened to `string | null`:
`RevokeArgs.revokedByUserId`, `consentService.revokeConsent`,
`studentShareInviteService.cascadeRevokeAllForStudent` / `revokeObjectShare` /
`revokeStandingShare`, `shareInviteRepository.revokeObjectShare` /
`revokeStandingShare`, `dualAgentService.terminateSessionsForStudent`. No
migration. A null there means "not a user of this system", never "unknown" — the
audit row names the person via `revoked_by_contact_id`.

#### What happens to a live AAC session

Unchanged from §7.5 and it fires on this path: `consentService.revokeConsent`
calls `dualAgentService.terminateSessionsForStudent`, which fires each cached
session's `onTerminate`; `live-relay.ts:2596` sends `error:CONSENT_REVOKED` over
the WebSocket and closes it cleanly, the cache entry is evicted, and an `update`
activity row with `details.action='aac_session_terminated'` is written. This is
**unconditional** — it does NOT depend on `CONSENT_GATE_ENABLED`. The flag only
governs whether a NEW session is refused at `initializeSession`; with the flag
off the child could immediately start a new session even though the old one was
killed. That is the pre-existing gate semantics, not something this build
changed, but it is the honest answer to "what happens to a live session".

#### The clinic notification

⚠️ **There was no notification machinery to reuse.** There is no notifications
table, no notification service, and no clinician-visible activity feed —
`/api/admin/activity-logs` is gated on `isAdminIdentity` (Aivota staff), not
`instituteUsers.isAdmin`. Before this, a withdrawal was discoverable only by a
clinician later hitting a `consentGate` refusal or noticing
`ConsentMissingIndicator`. So this is email to the institute's ADMIN members
(`instituteRepository.getInstituteMembers` → `membership.isAdmin` → `user.email`;
`institutes` has no contact address of its own), through the same injected
dispatcher as everything else in the service.

It is scoped to THIS path deliberately. The `signer` / `system_admin` /
`attest_parity` revocations are untouched — each is performed by a logged-in
person already in the room, and adding a send to them would also make four
existing consent suites mail live clinician addresses over the test
environment's real SES credentials.

#### Test seam

`setWithdrawalDispatcher` / `resetWithdrawalDispatcher` inject email + SMS. This
exists because the test environment carries LIVE SES credentials
(`server/tests/setup.ts` strips LLM keys and touches no `AWS_*` variable), and
this is the one consent suite that must give contacts real addresses — delivery
IS the feature, so the "no email on file" trick the other suites use cannot
apply. The pattern is the repo's own
(`securityIncidentDispatcher.ts`, `accessReviewCron.ts`): inject at the function
boundary, never `NODE_ENV`-guard a shared sender.

---

## 6. UI — clinician client

### 6.1 React Query hooks — `client/src/hooks/useConsentApi.tsx`

`useConsentNotice`, `useConsentWizardContext`, `useActiveConsent`, `useSignConsent`, `useRevokeConsent`. Mutations invalidate `consent-active` and `consent-wizard-context` keys.

### 6.2 The wizard — `client/src/features/consent/ConsentWizard.tsx`

**Three modes, one component**: `session` (the logged-in parent), `token` (a
magic-link parent with no account), and `attest` (`attestContactId` set — the
guardian is in the room and the clinician records the consent). They share the
component rather than forking it because the parts that must not drift are
exactly the parts they share: the notice render, the notice-hash round trip
(the server refuses `notice_hash_mismatch`, so a second wizard that rendered the
notice even slightly differently would be refused), the three required
disclosures and the opt-in defaults.

Five steps:

1. **Identity** — read-only display of student + signing parent (from wizard-context).
2. **Guardian** — government-ID fields (type / country / number) + the co-guardian declaration checkbox. Prefilled from the auto-created contact + license inviteDefaults.
3. **Notice** — scrollable rendering of the active notice plus the recipient list, with three required acknowledgement checkboxes (purpose / voluntariness / transfers). "Next" disabled until all three are ticked.
4. **Opt-ins** — four switches, all default off. Wizard does not surface forced-off semantics yet (server forces them at sign time when regime requires).
5. **Review** — summary card and the Sign Consent button. Submission posts to `POST /api/consent/students/:studentId/sign` with v1 family-flow defaults: `identityVerificationMethod = nonRepudiationMethod = 'authenticated_session'`, `isSensitive: false` (standard regime context).

### 6.2.1 Attest mode

Entered with `attestContactId` (plus `studentId`). Differences from the parent
flow, all of them copy or one extra step:

- Context comes from `wizard-context?contactId=` — the clinician does not own
  the contact, so the default "contact linked to the current user" lookup finds
  nothing and the wizard would otherwise show its no-guardian dead end.
- Step order gains `attest`, placed **after** `signature`: the clinician hands
  the device over for the signature, takes it back, and only then declares what
  they saw. Declaring first would attest to an act that has not happened yet.
- The `attest` step captures `guardianPresent` (required to advance) and an
  optional free-text note, and displays the guardian, the document type from the
  guardian step, and the attesting clinician. The ID number is **not** re-typed
  here.
- Identity / guardian / signature / review steps swap in attest-mode copy
  (`consent.wizard.attest.*`) — "hand the device to the guardian now", "the
  guardian confirms…" rather than "I confirm…".
- Submits to `useAttestConsentInPerson` → `/attest-in-person`. The payload
  carries no IDV method, no non-repudiation method and no `isSensitive`.

**Rail entry point** — `client/src/features/guided-setup/consent-branch.ts`. The
`sendRequest` branch (institution + a reachable guardian) is the one branch with
two moves, and `offersInPersonAttestation(branch)` names that rule so the rail
does not re-derive it. It is deliberately NOT offered on the other branches:
`sign` is the family path (that user *is* the guardian), `addGuardian*` has
nobody to attest for, and `wait` is excluded for the same reason it offers no
second link — a live magic link plus a desk signature would be two open paths to
one consent record, and the invitation would stay redeemable afterwards. A
guardian who walks in while a link is outstanding is handled by revoking the
invitation first (Pending consent requests → Revoke), which returns the gate to
`sign_required` and this branch.

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
| **Student chat-memory write (AI tool)** — `Student_People` / `Student_Interests` / `Student_CommunicationStyle` / `Student_Preferences` / `Student_Notes` | `student-memory-schema.ts` — the four shared helpers `setStudentMemoryField` / `addToStudentMemoryArray` / `deleteFromStudentMemoryArray` / `clearStudentMemoryArray`, which every one of those fields' `write`/`add`/`delete`/`clear` ops routes through | Same. Reads untouched. |
| **`Student_CommunicationProfile` (column-backed)** | `student-memory-schema.ts` `db.write` **and** `sessionService.onUpdateMemoryValues` (the `students.communication_profile` update) | Same. Two layers because the schema op does not write the column — see "Two layers" below. |
| **`Relationship_Notes` write (AI tool)** | `relationship-memory-schema.ts` `setRelationshipMemoryField` | Same. It is `Student_Notes` one table over ("general notes about sessions with this student"), so leaving it open left a second identical door. |
| **AAC settings write (AI tool)** — `Context_AACPrompt` / `Context_AACAutoPrompt` / `Context_AACSettings` / social-trainer config | `aac-settings-memory-schema.ts` `writeAACSettings` (the single choke point all four route through) **and** `institute-memory-schema.ts` `aacSettingsOps.write` / `.update` (the second door from the institute AI) | Same. See §7.4 for why `aac_settings` is gated and what is deliberately still open. |
| **Student / relationship memory PERSIST** | `sessionService.onUpdateMemoryValues` — `mayPersistStudentPhi` guards the `students.communication_profile` update, the `students.chat_memory` blob write and the `user_students.chat_memory` blob write | Drops the write and logs a warning. Does **not** throw: the AI has already been refused at the schema layer, and throwing here would abort the persistence that follows (relationship memory, the guided-setup refresh). |

Drafts can still be saved on all the above — only the transition to a final / live / shared state is gated.

**Two layers, and both are load-bearing (2026-09-10).** The `Student_*` and
`Relationship_*` memory-schema `db` ops do **not** write to the database. They
validate and return the value; the row write happens once, at the end of the
turn, in `onUpdateMemoryValues`. And `memory-db-bridge.processMemoryToolWithDB`
runs the in-memory processor for every op regardless of whether that op's DB
function threw — a failed op is reported to the model (`ok: false`, carrying the
`ConsentGateError` message) but its value is **not** rolled back out of
`memoryValues`. So the schema-layer refusal is what the AI READS, and the
`onUpdateMemoryValues` refusal is what stops the bytes. A gate in only one of
those places would either write the row after telling the model "refused"
(schema only) or leave the model with a confused silent no-op (persist only).
`Student_CommunicationProfile` is the sharpest case: it is column-backed and its
only writer is that persist path. `mayPersistStudentPhi` consults
`getConsentStatus`, which mirrors `requireActiveConsent`'s decision tree exactly,
so the flag and the legacy grace window are still the helper's business and are
not re-implemented.

Why this was needed: observed live on 2026-09-08 (the "Ray Cairo" session), the
assistant was sitting on a consent-BLOCKED guided-setup step, went interviewing
the user about the child's communication, and wrote
`Student_CommunicationProfile` and `Student_CommunicationStyle`. Nothing at the
data layer refused it — the only thing standing in the way was the prompt's
`WAITING FOR CONSENT` block, and prompt text is not an enforcement mechanism.

Tests: `server/tests/integration/consent-gate-student-memory.test.ts` (every
gated op refused / permitted across gate-off, legacy-grace and signed-consent,
plus the §7.4 exemption pins) and `server/tests/consent-gate-persist-path.test.ts`
(DB-free; pins that all three writes in `onUpdateMemoryValues` sit behind the
guard, since that closure has no seam a test can call).

### 7.3 AI awareness layer

The AI shouldn't produce confused tool failures when blocked. Two pieces:

- **Error message is AI-readable.** `ConsentGateError.message` says: *"Cannot access or modify this student's data: no active informed-consent record exists for the student (id=…). Ask the user to complete the consent wizard for this student before retrying."* When a memory-schema op throws, this message reaches the AI as the tool error.
- **Prompt-level pre-warning.** `sessionService.getMessageManager` calls `getConsentStatus(studentId)` and appends a `[CONSENT STATUS]` block to `template.corePrompt`. Three variants: gate off → no injection; active → "PHI ops permitted"; legacy grace → soft note with the deadline; consent pending → strong warning naming what will fail and the user-facing CTA. The AI sees this at session-init and can explain blocked operations to the user without confusion.

### 7.4 What is *not* gated (deliberately)

Each of these is a considered carve-out, not an oversight, and each is pinned by
a regression test in `consent-gate-student-memory.test.ts` so a future tightening
cannot quietly dead-end onboarding.

- **Reading basic identity** (name, age) — needed by the wizard itself; treating directory-level info as gated would create a chicken-and-egg. More generally **the gate is write-only**: every `read` op in every gated schema passes regardless of consent state.
- **Editing `student_contacts`** — needed to obtain consent at all, and *more* load-bearing since 2026-09-09: the guided flow now ASKS for and SAVES the guardian contact **during** the consent wait (`student-setup-flow.ts` `awaitingConsentBlock`, the `needsGuardian` branch), and that contact is the single named exception in the prompt's own blanket "No `Student_*` memory writes" prohibition. There is nothing to send a consent link *to* until that row exists, so gating contacts would mean a consent-pending student could never stop being consent-pending.
- **Creating consent records** — by definition.
- **Drafting programs / records** — clinicians shouldn't lose work; only the final-state transition gates. `reportService.createMedicalRecord` (the draft path) carries no gate; `reportController.finalizeMedicalRecord` does.
- **`Student_CustomApps` / `Student_Packages`** — assignment/provisioning rows on their own tables (custom-app and package assignment), governed by `custom_app_assignment` / `package_assignment` access rather than by consent. They record what a student is *licensed for*, not an observation *about* the child, and blocking them would put provisioning behind a gate that provisioning may legitimately precede.
- **The non-memory-schema writers of `aac_settings`** — `aacSettingsRepository.createDefaults` (called at student creation: a student with no settings row is not a usable record), the clinician settings panel and the AAC client (`studentService.updateAacSettings` / `PATCH /api/students/:id`), the guided-setup AAC step (which is behind the flow's *own* consent gate already), and the in-session writers (local-storage encryption key, learned seizure baselines, Spotify app config — all inside a session `requireActiveConsent` has already admitted). What §7.2 gates is the **AI memory-schema door** into that table.

**The `aac_settings` judgement call (2026-09-10).** The AI's write path to
`aac_settings` **is** gated, and the reasoning is worth recording because it
could defensibly have gone the other way. For: `autoAacPrompt` is the
assistant's own free-text notes about the child — by its own field description,
"communication level, interests, triggers, physical and cognitive abilities,
people around them" — which is the Ray Cairo content in a different column, so
leaving it open would have left the hole open; and an AAC session cannot start
without consent anyway (`dualAgentService.initializeSession`), so a settings
write before consent configures a session that cannot legally run. Against:
`aac_settings` also holds pure display/provisioning dials (voice, grid, symbols)
that are not PHI. The against-case is answered by scope rather than by leaving
the table open — the gate is on the **memory-schema** door only, and every
legitimate pre-consent writer listed above reaches the table by a different
path and is untouched. So the gate costs nothing operationally and closes the
class of hole rather than one instance of it.

### 7.5 Cascade revocation

Three-prong cascade fires from `consentService.revokeConsent` after the consent record is marked revoked:

1. **Per-object & standing shares** — `studentShareInviteService.cascadeRevokeAllForStudent` lists every active grant for the student and revokes each via the existing single-grant methods. Each per-grant revoke fires its own audit entry tagged `details.cascade_reason='consent_revoked'`. Callers pass `extraDetails` to distinguish cascade from one-off revocations.
2. **Active AAC sessions** — `dualAgentService.terminateSessionsForStudent` iterates the in-memory session cache, fires the registered `onTerminate` callback (LiveRelay sends `error:CONSENT_REVOKED` and closes the WebSocket cleanly), evicts the cache entry, logs an `update` activity event with `details.action='aac_session_terminated'`. Lazy-imported to keep the dual-agent module chain out of consent-only test runs.
3. **Re-consent at age-out** — `runMinorThresholdCheck` daily cron (see §7.6) does NOT auto-revoke; it just emits `minor_threshold_crossed` events for human follow-up.

Cascade failures are logged but non-fatal — the consent withdrawal is the legally binding act and must complete even if downstream cleanup partially fails.

The cascade is **path-independent**: it fires identically whether the revoker is
the original signer, a system admin, an institute member acting under attest
parity (§5.2), or **the signer withdrawing over a withdrawal token with no user
account at all (§5.3)**. The only thing those paths add is a
`details.revocation_path` key on the `consent_revoked` row itself; the per-grant
`details.cascade_reason='consent_revoked'` tag on each revoked share is
untouched. Pinned by `consent-revoke-permission.test.ts` ("still cascades to
active shares when revoked through the parity path") and by
`consent-withdrawal-token.test.ts` ("cascades to active shares, exactly as every
other revocation path does"), both of which assert the cascade tag still lands on
exactly the two grants.

On the §5.3 path the acting user id is **null** all the way down, and each
revoked grant records `revoked_by_user_id = NULL` rather than failing on the FK.
The columns were always nullable; only the TypeScript signatures assumed an
account (see §5.3, "Null actor").

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
| `consent_revoked` | `consent_record` (id) | `student` (id) | `reason`, `priorVersion`, `priorRegime`, `revocation_path`; on the parity path also `attested_by_user_id` + `identity_verification_method`; on the `signer_token` path also `withdrawal_invitation_id`, `withdrawal_channel`, `withdrawal_second_factor`, `revoked_by_contact_id`, `identity_verification_method`, `withdrawn_from_ip` / `withdrawn_from_user_agent` and the factor evidence (`otpVerifiedAt` / `otpRecordId`, or `childIdVerifiedAt` / `childIdVerifyMethod`) | `consentService.revokeConsent` |
| `share_revoked` (cascade) | `student` (id) | `share_invite` (id) | `scope: 'object_share'`, `objectShareId`, `objectType`, `cascade_reason: 'consent_revoked'` | cascade path |
| `standing_share_revoked` (cascade) | `student` (id) | `share_invite` (id) | `standingShareId`, `cascade_reason: 'consent_revoked'` | cascade path |
| `guardian_id_verified` | `student_contact` (id) | `student` (id) | `consentRecordId`, `attestingClinicianUserId`, `identityVerificationMethod`, `verificationProvider: 'clinician_attested'`, `guardianPresent`, `identificationType`, `identificationCountry`, `idvRegime`, `signatureMode` | `consentController.attestInPerson` |

An in-person attestation therefore writes **two** rows, and both distinguish it
from a self-signed consent:

- `consent_signed` — the same event the parent flow fires, but with
  `details.identityVerificationMethod = 'in_person_clinician_attested'` and
  `userId` = the attesting clinician rather than the guardian. This is what a
  query over consent records keys off.
- `guardian_id_verified` — the attestation act itself, so "which guardians did
  clinician X vouch for" is answerable without reading consent records. This
  event type had been allocated since the original build and never emitted;
  this is its first emitter.

A revocation records **who** (`userId` = `revoked_by_user_id`) and **under which
rule** (`details.revocation_path`, one of `signer` / `system_admin` /
`attest_parity` / `signer_token`). The path is written on every revocation, not
only the new ones, so "the clinic withdrew this on the guardian's behalf" is a
positive assertion in the row rather than something inferred from the absence of
a key.

`signer_token` (§5.3) is the FOURTH value and the only one where `userId` is
NULL — that signer has no account, which is the entire premise of the path. It is
deliberately NOT folded into `signer`: that label means "an authenticated user who
is the signing contact's linked account", and a reader of the log must be able to
tell "the parent proved possession of the phone we already had on file and clicked
withdraw in their own browser" from "the parent logged in and clicked withdraw".
The evidentiary chains are different, so the labels are. WHO withdrew is carried
by `details.revoked_by_contact_id`, and HOW they proved it by
`details.withdrawal_second_factor` (`phone_otp` | `child_id_last4` |
`token_only`). Note `revoke_path_for` in `consentController.ts` returns only the
three SESSION-produced values — `signer_token` is decided by possession of the
token in `consentWithdrawalService` and never passes through it.

Two further rows on the §5.3 path, both `eventType: 'update'` (never a second
`consent_revoked` — that would make "how many consents were withdrawn" a wrong
count in every audit query that trusts the event type):
`details.action='consent_withdrawal_link_sent'` when a link is minted (with
`origin: 'guardian_request' | 'clinician_reissue'`), and
`details.action='consent_withdrawal_clinic_notified'` per institute, which
carries the `instituteId` the `consent_revoked` row does not have — so a clinic's
filtered view of the log can see that it was told.
On the `attest_parity` path the row additionally carries
`attested_by_user_id` (lifted from the record's
`identity_verification_evidence.attestingClinicianUserId`) and
`identity_verification_method`, so a single audit row answers "who vouched for
this guardian, and who tore it up" without a second lookup. Pinned by
`consent-revoke-permission.test.ts`.

Events allocated but still not emitted: `consent_re_signed`.
(`minor_threshold_crossed` IS emitted — by the age-out cron, §7.6. This list
previously named it as unemitted, contradicting §7.6 on the same page.)

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
- **Right to revocation** — `revokeConsent` endpoint; cascade tears down active shares. Since 2026-09-10 a signer with no user account can exercise it themselves (§5.3) rather than depending on the clinic.

### 10.2 US — FERPA + COPPA

- **COPPA under-13 protections** — `us_coppa` regime forces opt-ins off regardless of UI submission. Method registry restricts COPPA to enumerated VPC methods (`signed_form_upload`, `credit_card_match`, `video_session_recorded`, `gov_sso`, `third_party_idv`); `verified_phone_otp` is rejected for COPPA contexts.
- **2025/2026 amendments** — opt-ins default off; advertising / training / research / marketing each independently controlled; the service must function fully with all four off.
- **FERPA "school official" exception** — `share_legal_basis` enum has `institutional_delegate` for the regime-neutral version. Default `guardian_consent` is conservative.

### 10.3 EU — GDPR

- **Article 8 minor consent** — `eu_gdpr_minor` regime triggers per EU member state list at age < 16.
- **Article 9 special-category data** — `eu_gdpr_art9` IDV regime context required for sensitive medical data; method registry restricts acceptable IDV.
- **Article 13/14 informed-notice** — covered by the same notice structure (purpose / voluntariness / recipients / retention / rights / contact).
- **Article 7(3) "as easy to withdraw as to give"** — §5.3. Giving is a link in an email with a second factor; withdrawing is now a link in an email with the SAME second factor, computed by the same functions. This is the only regime that drove the build: nothing in `shared/legal/` imposes a withdrawal-specific bar, and COPPA §312.6 arguably permits a lower one, which is deliberately not taken.

### 10.4 Cross-jurisdiction

- **Data-controller obligations independent of authentication mechanism** — the PPA explicitly stated MoE SSO doesn't discharge the Section 11 notice. The system collects the notice every time regardless of auth path; gov-SSO populates only the `governmentIdVerifiedVia: 'gov_sso'` evidence field, never the notice itself.
- **Versioned notice + recipient snapshot** — when the recipient list changes, version bumps; existing consents remain valid only for what they explicitly disclosed.
- **Frozen jurisdiction at sign time** — students.country can later be edited; the consent record's `country` and `regime` stay as they were.

---

## 11. What is NOT yet implemented

These are deliberately deferred and currently absent:

- **Stronger IDV flows** — the wizard implements `authenticated_session` (family path, standard regime), `verified_phone_otp` (magic-link path) and `in_person_clinician_attested` (clinic desk, §5.1). Still unbuilt: recorded video session, third-party IDV vendor (IDnow / Stripe Identity / Onfido), gov SSO (MoE Sapakim, login.gov). Photo/scan capture of the inspected ID is deliberately NOT part of the in-person path — nothing in the legal layer requires it, and it would add an image of a government document to a store whose ID column is already an open encryption finding.
- ~~**Revoking a clinician-attested consent.**~~ **RESOLVED 2026-09-09 — see §5.2.** "Attest permission = revoke permission", scoped to records whose `identityVerificationMethod` is `in_person_clinician_attested` and nothing else. The same `attestPermissionFor` predicate (and the same `ATTEST_REQUIRES_INSTITUTE_ADMIN` constant) gates both the attestation and the withdrawal.

- ~~**A guardian with no account still cannot withdraw consent themselves.**~~
  **RESOLVED 2026-09-10 — see §5.3.** A withdrawal token addressed to the SIGNER
  rather than to a session: minted on request, delivered only to a channel already
  on file, single-use, 72h, hashed at rest, bound to ONE consent record, verified
  by the SAME second factor the sign flow used for that channel, landing on a
  public page that spells out the consequences and requires an explicit
  confirmation, and calling the same `consentService.revokeConsent` so the §7.5
  cascade is unchanged. The receipt now carries a REFERENCE URL (not a token) that
  mails a fresh link to the address on file. Audit gained the fourth
  `revocation_path` value, `signer_token`. Coverage is total over token-signed
  records: guardian-contact records (magic-link and in-person-attested) and
  magic-link SELF-signed records; a signer who HAS an account is refused, because
  the session path is already theirs.

  Residual, deliberately not built: a signer whose contact row carries NEITHER an
  email nor a phone, and whose record has no originating invitation to read a
  destination off (an in-person attestation for a walk-in guardian with no contact
  details recorded). There is nowhere to send a link, so for that record the answer
  is still §5.2's attest parity — the clinic withdraws on their behalf — or a
  system admin. `canSendWithdrawalLink` on `/history` is false for it, so the
  affordance is not offered rather than offered and failing. The fix is data
  (record a contact channel at intake), not code.

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
- `drizzle/0180_unknown_power_man.sql` — `consent_invitations.purpose` + `target_consent_id` + nullable `created_by_user_id` (§5.3).

### Server-side
- `shared/legal/types.ts` / `minor-protection.ts` (incl. `REGIME_THRESHOLDS`) / `idv-methods.ts` / `recipients.ts` / `consent-notices/` / `index.ts` — adapter layer.
- `server/repositories/studentConsentRecordRepository.ts` / `consentInvitationRepository.ts` — DB layer.
- `server/services/consent/consentService.ts` — sign/revoke/lookup; cascade share-revoke + AAC session termination on revoke; `revokeConsent` takes an optional `extraDetails` merged into the `consent_revoked` audit row.
- `server/services/consent/consentInvitationService.ts` — magic-link create / redeem / sign-with-token / revoke. Also exports the pieces the WITHDRAWAL flow must share so the two bars cannot drift: `loadActiveInvitationByCode(code, purpose)` (the purpose check is a security check), `getChildInstituteIdNumber`, `normalizeIdLast4`, `CHILD_ID_MAX_VERIFY_ATTEMPTS`, `CONSENT_LINK_MAX_TTL_HOURS`, `maskPhone`, `escapeHtml`.
- `server/services/consent/consentWithdrawalService.ts` — **§5.3**: mint / context / OTP / child-ID / confirm, the clinician re-issue, `canIssueWithdrawalLink` (feeds `canSendWithdrawalLink`), the clinic notification, and the `setWithdrawalDispatcher` test seam.
- `server/services/consent/consentReceipt.ts` — now carries the withdrawal REFERENCE url (`/consent/withdraw#ref=<consentId>`) alongside "contact the clinic".
- `server/services/consent/consentGate.ts` — `requireActiveConsent`, `getConsentSnapshot`, `getConsentStatus`, `requireConsentForMemoryWrite`, `requireConsentForResponse`, `ConsentGateError`.
- `server/services/consent/consentThresholdCron.ts` — `runMinorThresholdCheck` + scheduler.
- `server/services/consent/guardianContactAutoCreate.ts` — auto-create guardian contact on first family-institute student.
- `server/services/smsService.ts` — pluggable SMS provider with bypass flag.
- `server/services/sharing/studentShareInviteService.ts` — `cascadeRevokeAllForStudent`, `revokeObjectShare`/`revokeStandingShare` extended with `extraDetails`.
- `server/repositories/shareInviteRepository.ts` — `listAllActiveSharesForStudent`.
- `server/services/dual-agent/dual-agent-service.ts` / `live-relay.ts` — gate at AAC session start; `terminateSessionsForStudent`; `injectTestSession`; `onTerminate` callback wiring.
- `server/services/sessionService.ts` — `formatConsentStatusForPrompt` + corePrompt injection.
- `server/services/memory-schema/incident-memory-schema.ts` / `reports-memory-schema.ts` / `progress-memory-schema.ts` — `requireConsentForMemoryWrite` at AI write boundaries.
- `server/controllers/consentController.ts` — HTTP surface (notice / wizard-context / sign / **attest-in-person** / revoke / list-history / list-invitations / create-invitation / redeem-invitation / sign-invitation / revoke-invitation / **the six public `withdraw/*` endpoints and the institute-admin `:consentId/withdrawal-link` re-issue**). Holds `attestPermissionFor` / `assertAttestPermission` (the ONE attest predicate, shared by the attest write and attest-parity revoke), `revokePathFor` (all revoke rules + the audit label), and the in-person constants `IN_PERSON_IDV_METHOD`, `IN_PERSON_ID_PROVIDER`, `IN_PERSON_IS_SENSITIVE`, `ATTEST_REQUIRES_INSTITUTE_ADMIN`. ⚠️ **2026-09-10:** the student PREDICATES were promoted out of this file into `server/services/access/` and renamed — `assertStudentAccess` → `assertSharesInstituteWithStudent`, `userSharesInstituteWithStudent` → `sharesInstituteWithStudent`, `userIsAdminForStudent` → `administersStudentInstitute`, plus `assertWizardContextAccess`. Same rules, same admit/deny sets (the consent suites are the evidence); see docs/SECURITY_ARCHITECTURE.md §5.4.2. Older names elsewhere in this document refer to these. `revokePathFor` returns only the three SESSION-produced paths; `signer_token` (§5.3) is decided by token possession in `consentWithdrawalService` and never passes through it.
- `server/controllers/reportController.ts` / `programController.ts` — gate at finalize/activate paths.
- `server/controllers/licenseController.ts` + `server/services/licenseService.ts` — guardian-identity inviteDefaults plumbing.
- `server/index.ts` — calls `scheduleMinorThresholdCheck` at boot.
- `server/routes.ts` — `/api/consent/*` routes.

### Client-side
- `client/src/hooks/useConsentApi.tsx` — React Query hooks (notice / wizard-context / active / history / sign / **attest-in-person** / revoke / pending-invitations / revoke-invitation / consent-invitation context / sign-with-token / create-invitation). The four student-scoped READS are `@internal ConsentProvider only`; `useConsentWizardContext` and the mutations are not.
- `client/src/features/consent/ConsentWizard.tsx` — the wizard; session-mode, token-mode and attest-mode (§6.2.1).
- `client/src/features/consent/ConsentProvider.tsx` — the ONE observer of the four student-scoped consent reads.
- `client/src/features/guided-setup/consent-branch.ts` — `consentBranch` (total over account/gate/contact) + `offersInPersonAttestation`.
- `client/src/features/guided-setup/GuidedSetupRail.tsx` — the consent card; "Send consent request" and "The guardian is here — sign together".
- `client/src/components/GlobalAuthModals.tsx` — `openUI('consentWizard', { studentId, attestContactId? })` listener.
- `client/src/features/consent/SendConsentRequestDialog.tsx` — clinician dispatch dialog (email / SMS / copy-link).
- `client/src/features/consent/PendingInvitationsList.tsx` — in-flight invitations + revoke.
- `client/src/features/consent/ConsentHistoryPanel.tsx` — collapsible audit-grade timeline; the Revoke button renders only when the server-computed `canRevoke` on that record is true (§5.2).
- `client/src/pages/ConsentSignPage.tsx` — public magic-link landing page (`/consent/sign?code=`).
- `client/src/pages/ConsentWithdrawPage.tsx` — **§5.3** public withdrawal page (`/consent/withdraw#ref=` or `#code=`). Never withdraws on load.
- `client/src/components/StudentModal.tsx` — auto-launch wizard on family-institute student creation.
- `client/src/components/admin/LicenseForm.tsx` — guardian-identity prefill capture.
- `client/src/features/StudentInfoPanel.tsx` — banner + buttons + history.
- `client/src/App.tsx` — public route registration for `/consent/sign` and `/consent/withdraw`.
- `client/src/i18n/*.ts` — 11 locales with `consent.wizard.*` (incl. `consent.wizard.attest.*`, 19 keys) / `consent.notice.*` / `consent.sign.*` / `consent.send.*` / `consent.pending.*` / `consent.history.*` (incl. the 5 withdrawal-link keys) / `consent.withdraw.*` (44 keys, §5.3) / `guidedSetup.consent.attestInPerson` + `attestCaption` / `admin.licenses.guardianIdentity.*` keys.

### Tests
- `server/tests/integration/consent.test.ts` — 11 service-layer tests.
- `server/tests/integration/consent-gate.test.ts` — 10 gate-helper tests.
- `server/tests/integration/consent-api.test.ts` — 18 controller tests, including the
  `/wizard-context` membership gate (2026-09-10): institute member 200, a linked
  guardian contact with NO institute membership 200 (the pin that stops the parent
  path being "simplified" back to institute overlap), a `user_students`-linked
  family owner with no institute 200, an unrelated authenticated user 403, the
  enumeration-safe 403-vs-404 on a missing student, and the `?contactId=` variant
  still refusing that same linked guardian.
- `server/tests/consent-route-guards.test.ts` — 36 source-level route-middleware
  pins (DB-free, `test:unit`): every public consent route carries `authRateLimiter`
  and not `requireAuth`, every session route carries `requireAuth`, and no
  `/api/consent/*` route has neither.
- `server/tests/integration/consent-gate-wiring.test.ts` — 5 finalize/activate wiring tests.
- `server/tests/integration/consent-cascade-revoke.test.ts` — 2 cascade tests.
- `server/tests/integration/guardian-contact-auto-create.test.ts` — 6 auto-create tests.
- `server/tests/integration/consent-ai-gate.test.ts` — 9 memory-schema gate + status-snapshot tests.
- `server/tests/integration/consent-invitation.test.ts` — 9 invitation service tests.
- `server/tests/integration/consent-invitation-api.test.ts` — 7 invitation controller tests.
- `server/tests/integration/consent-threshold-cron.test.ts` — 5 cron tests.
- `server/tests/integration/consent-revoke-permission.test.ts` — 11 attest-parity revoke tests: the widening, its audit row, the cascade through the new path, the NARROW-SCOPE pin (a parent-signed record is refused to the same member) plus its own non-vacuity control (that member reads that student's history at 200, so the 403 is about the record and not about access), both no-overlap refusals, the unchanged signer and system-admin paths, and the `canRevoke` flags on `/history`.
- `server/tests/integration/consent-withdrawal-token.test.ts` — 22 tests over §5.3: the end-to-end withdrawal for a magic-link record and for an attested one, the email/child-ID channel, the second factor enforced AT THE COMMIT (both channels) with nothing committed on refusal, the explicit-confirmation refusal, single-use / expiry / cross-record binding, BOTH purpose-confusion refusals, enumeration safety (real vs bogus vs garbage reference produce identical bodies and different invisible side effects), the linked-signer and already-revoked no-ops, the re-issue throttle, the cascade with a NULL actor, the `signer_token` audit row, the clinic notification, the `canSendWithdrawalLink` flags, the pending-list purpose filter, and a NON-VACUITY control proving the same record was refused by the pre-change revoke endpoint.
- `server/tests/integration/consent-attest-in-person.test.ts` — 11 in-person attestation tests, including the COPPA legal pin (the registry rule, the 422 for a US under-13 with the specific `us_coppa` / `identity_method_not_accepted_for_regime` details, and the non-vacuity control: a US 14-year-old is NOT refused for that reason) and the pin that `/sign` still refuses an unlinked contact.
- License test additions: `server/tests/integration/license.test.ts` covers guardian-identity inviteDefaults storage.
- `server/tests/helpers/http.ts` — fake req/res helpers (now with `.get()` stub for header-aware controllers).

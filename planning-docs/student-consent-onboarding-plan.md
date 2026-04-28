# Student Consent & Onboarding — Plan

## Problem

Today the cross-institute sharing system (`cross-institute-sharing-plan.md`) handles **per-disclosure** consent: every cross-institute share is its own ROI transaction with explicit guardian approval. That's the legal floor for *moving* PHI around.

It assumes that the **baseline data-collection consent** — the legal authority to put a student in our system at all — has already been obtained by some means. It hasn't. We collect a `firstName`, `birthDate`, and `instituteIds[]` and create the row; nothing checks that the creating user has the legal right to do so on the student's behalf, and nothing records that the student's guardian has been informed how the data will be used.

This plan adds that layer.

## Scope

Five compliance items not covered by `cross-institute-sharing-plan.md` or `ministry-of-education-integration.md`:

1. **Guardian verification at student creation** — collect a government identity number, capture the legal-guardian declaration, capture co-guardian acknowledgment when applicable. ID type and format vary by country; the schema stays country-agnostic and lets a per-country adapter validate format.
2. **Informed-consent notice at point of data collection** — purpose, voluntariness, third-party recipients — captured per student with versioned, per-country text. The Israeli "Section 11" notice (PPL §11) is one instance; GDPR Articles 13/14, COPPA's "direct notice", and other regimes impose materially the same disclosure obligations with different wording.
3. **Minor-protection gate** — when the signing student is below the age threshold for the applicable jurisdiction (US/COPPA: 13, EU/GDPR: typically 16, UK: 13, etc.), enforce stricter consent rules. The threshold is per country, not hardcoded.
4. **Opt-in for non-essential processing** — separate, defaulted-off toggles for AI training, advertising, third-party research, marketing comms.
5. **Cross-institute share legal-basis tagging** — record which legal basis was used for each share (guardian consent / school-official-style exception / formal release of information). Low priority; explicit guardian consent is always conservative.

## How MoE SSO composes

Sapakim's full attribute set is behind gated vendor PDFs (researched 2026-04-27). We can't rely on specific claim names until vendor onboarding. What we can design around:

| MoE may provide | We still need |
|---|---|
| Teudat Zehut as a SAML attribute (likely; unconfirmed) | Manual TZ entry path for parents who don't / can't authenticate via Sapakim |
| Parent-child relationship assertion (uncertain — MoE's parent-side data model is in flux per 2026-04 PPA scrutiny) | Independent legal-guardian declaration regardless of MoE assertion (the *declaration* is a legal statement, not an identity fact) |
| Role differentiation (parent / teacher / staff) | Our own role/permission model — MoE roles don't map 1:1 to family/school/clinic institutes |
| Nothing for Section 11 | All Section 11 notice delivery + capture |
| Nothing for COPPA / FERPA / non-educational opt-ins | All of these |

**PPA position** (Feb 2026, explicit): Section 11 informed-consent notice is a standalone obligation on the data controller. MoE SSO authenticates; it does not discharge the notice.

**Design rule**: build the consent system MoE-aware but never MoE-dependent. When MoE SSO arrives, it populates `governmentIdVerifiedVia: 'moe_sso'` on the verification record and pre-fills the TZ field. The consent transaction itself (notice shown + signature + opt-ins) is always ours.

## How family-institute composes

`family` is one of three values in `instituteTypeEnum` (`shared/schema-private.ts:17`). The existing flow:

- Institutes are created only via the admin/license system (the in-product "create institute" affordance is hidden by design and unused). A family institute exists when an admin has provisioned one for a parent against a license.
- Parents are added as admins of their family institute via the same admin/license path.
- Once provisioned, the parent creates students with `instituteIds: [familyInstituteId]` through the normal student flow.
- Family-institute escalation in `buildClinicianCtx` already grants student-equivalent PHI access to family-institute admins for their wards.

Convenience optimisation: when a parent creates a student inside a family institute, the parent IS the consenting guardian by definition. We can prefill `signedByContactId` with their own contact record and skip the "who is signing" step. They still see the Section 11 notice (the law requires the disclosure to happen, regardless of who already-knows what). They still tick the legal-guardian + dual-guardian declarations. But they don't have to type their own name and ID twice — those come from their user record.

For students created by a clinician/school admin inside a non-family institute, the consent transaction has to reach the parent through a verified channel — see "Identity verification & non-repudiation" below for the full method list. The student record stays in a `consent_pending` state — visible in the admin UI but blocked from sharing, AI processing, and report generation — until a verified consent record exists.

## Guardian-identity prefill via license provisioning

The license/admin provisioning flow (`server/services/licenseService.ts:40`, `client/src/components/admin/LicenseForm.tsx`) is the only path through which family institutes are created. It currently captures `firstName`, `lastName`, `userType`, and the institute fields, then emails an invite. There are two seams to extend so the parent doesn't have to retype their identity at consent time:

### Seam 1: license-creation form

Extend `LicenseForm.tsx` (lines 279–323, the recipient block) with optional fields when `instituteType === 'family'`:

- Country (ISO 3166-1 alpha-2, default to admin's country)
- Government ID type + number + country (admin enters what they collected from the parent off-band — invoice, intake call, etc.)
- Phone (admin attests to verification — typically the phone that was already used to coordinate the license purchase)
- "Identity verification provenance" notes — free text, e.g., "verified via passport scan during call 2026-04-20"

These fields ride on `license.inviteDefaults` JSON (currently `{ firstName, lastName, userType }`); extending the JSON shape requires no migration. The license-service `createLicenseWithSetup` (`licenseService.ts:62`) writes them; `instituteController.registerWithInvite` (`instituteController.ts:911`) reads them at registration time.

When the admin captures these fields, they are also implicitly attesting that they verified the identity off-band. This becomes the seed for an `identityVerificationMethod = 'in_person_clinician_attested'` (or admin-attested equivalent) consent record later — the admin's user ID + the timestamp + their attestation note are the evidence.

### Seam 2: auto-create guardian contact on first student creation

When a user with admin role of a family institute creates their first student in that institute, the student-creation flow auto-creates a `studentContacts` row:

- `linkedUserId` = parent's user id
- `name` = parent's `fullName`
- `relationship` = `'parent_guardian'` (default; user can change)
- `role` = `'parent_guardian'`
- `contactEmail`, `contactPhone` = from user record (phone added below)
- `governmentIdNumber`, `governmentIdType`, `governmentIdCountry` = from license `inviteDefaults` (if captured)
- `governmentIdVerifiedVia` = `'manual_entry'` if the admin entered them; null otherwise
- `governmentIdVerificationProvider` = `'admin_attested'` if from `inviteDefaults` (free-text, distinct from a third-party IDV vendor)
- `isLegalGuardian` = false (until the consent wizard sets it)

The consent wizard then reads from this row, presents pre-filled values for confirmation, and asks for anything missing. Subsequent students by the same parent reuse the same `studentContacts` row (FK by `linkedUserId`).

### Schema additions to support seams

```ts
// users — fields useful across the platform, not just consent
country: text("country"),                    // ISO 3166-1 alpha-2
phone: text("phone"),                         // E.164
phoneVerifiedAt: timestamp("phone_verified_at"),

// license.inviteDefaults JSON shape (no schema change — type-only)
type InviteDefaults = {
  firstName?: string;
  lastName?: string;
  userType?: string;
  // new (family-institute provisioning):
  country?: string;
  phone?: string;
  governmentIdNumber?: string;
  governmentIdType?: 'national_id' | 'passport' | 'driver_license' | 'other';
  governmentIdCountry?: string;
  identityProvenanceNote?: string;  // free-text admin attestation
};
```

Adding `country` and `phone` to `users` is justified beyond consent — they're general profile fields. `phoneVerifiedAt` parallels existing `emailVerifiedAt` if present (check before adding).

### Where gov ID lives canonically

Same person, same gov ID across all their students — but we store it on `studentContacts`, which means duplication when a parent has multiple students. Three options considered:

- **Option A (chosen)** — store on `studentContacts`. Each row is the per-relationship legal artefact (the guardian-of-this-student declaration); duplication is small (text); a service helper propagates updates across all rows with the same `linkedUserId`.
- **Option B** — store on `users` for users-who-are-guardians, on `studentContacts` for non-user contacts. Cleaner per-person canonicalization but two read paths and a consistency burden.
- **Option C** — introduce a shared `personIdentityRecord` table linked from both. Mirrors the existing `biometricData` pattern. Cleanest but biggest change.

Recommend Option A for v1. Revisit Option C if multi-student parents update their ID often enough that the propagation pattern shows friction.

## Schema additions

### `student_contacts` — guardian verification fields

```ts
governmentIdNumber: text("government_id_number"),
governmentIdType: governmentIdTypeEnum("government_id_type"),
// 'national_id' | 'passport' | 'driver_license' | 'other'
// Country (on the contact, see below) disambiguates which national-id scheme:
// 'national_id' + IL = Teudat Zehut; 'national_id' + US = SSN; etc.
governmentIdCountry: text("government_id_country"),
// ISO 3166-1 alpha-2. Decoupled from the student's country — a guardian can
// be a US citizen consenting for a child resident in IL.
governmentIdVerifiedVia: idVerificationSourceEnum("government_id_verified_via"),
// 'manual_entry' | 'gov_sso' | 'third_party_idv' | null (null = unverified)
governmentIdVerificationProvider: text("government_id_verification_provider"),
// Free-text provider tag, e.g. 'moe_sapakim_il', 'login_gov_us', 'idnow_de'.
// Kept separate from the enum so adding a new provider is data, not migration.
governmentIdVerifiedAt: timestamp("government_id_verified_at"),

isLegalGuardian: boolean("is_legal_guardian").default(false).notNull(),
coGuardianAcknowledged: boolean("co_guardian_acknowledged").default(false).notNull(),
// Renamed from 'dualGuardianAcknowledged': in some jurisdictions there can be
// more than two legal guardians (foster arrangements, kinship care, etc.)
legalGuardianDeclaredAt: timestamp("legal_guardian_declared_at"),
```

`governmentIdNumber` is sensitive — encrypted at rest via the existing PHI-column pattern (check what we use for `biometricData`). Index by hash if we need uniqueness checks; never index plaintext.

`isLegalGuardian` + `coGuardianAcknowledged` are independent of `governmentIdNumber`: a contact can be a verified family member without claiming legal-guardian authority. Only contacts with `isLegalGuardian = true` are eligible to sign consent records or approve share invites.

The choice of which ID document to collect (and whether to collect one at all) is country-dependent — some jurisdictions don't have a single national ID and rely on driver's license / passport instead. A per-country adapter (in `shared/legal/`) returns the recommended ID type and format validator for the contact's country; the schema accepts whatever the adapter produced.

### New table: `student_consent_records`

```ts
export const studentConsentRecords = pgTable("student_consent_records", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  studentId: varchar("student_id").references(() => students.id).notNull(),
  signedByContactId: varchar("signed_by_contact_id")
    .references(() => studentContacts.id).notNull(),

  country: text("country").notNull(),
  // ISO 3166-1 alpha-2, frozen at signing time from students.country.
  // Drives which legal regime applies. Stored as text — not an enum — so
  // adding support for a new country is data, not migration.
  ageAtSigningYears: integer("age_at_signing_years").notNull(),
  // Frozen for audit. Computed from students.birthDate at signing.
  isMinorEnhancedProtection: boolean("is_minor_enhanced_protection").default(false).notNull(),
  // True when ageAtSigningYears < (per-country minor threshold).
  // Country adapter returns the threshold: COPPA=13 (US), GDPR=13–16 (per
  // member state), UK ICO=13, IL = no specific online threshold but
  // guardianship law applies until 18.
  enhancedProtectionRegime: text("enhanced_protection_regime"),
  // Free-text label: 'us_coppa', 'eu_gdpr_minor', 'uk_ico_under13', 'il_general',
  // null when not applicable. Used by the gate to look up regime-specific rules.

  consentTextVersion: text("consent_text_version").notNull(),
  // Versioned per country: e.g. 'IL.2026.04', 'US.2026.04', 'EU.2026.04'.
  consentTextHash: text("consent_text_hash").notNull(),
  // SHA-256 of the exact text shown to the signer. Versioned text lives in
  // a static module — we never lose the ability to reproduce what was shown.

  // Required disclosures — each must be true to submit. The set of required
  // acknowledgements is identical across all regimes we currently target:
  // purpose, voluntariness, recipient transparency. Wording differs by country
  // but the structural slots are universal.
  purposeAcknowledged: boolean("purpose_acknowledged").notNull(),
  voluntarinessAcknowledged: boolean("voluntariness_acknowledged").notNull(),
  thirdPartyTransfersAcknowledged: boolean("third_party_transfers_acknowledged").notNull(),
  thirdPartyRecipients: jsonb("third_party_recipients").notNull(),
  // snapshot of recipients disclosed at signing — frozen here too
  // shape: [{ category: 'llm_provider', name: 'Google Gemini', purpose: '...' }, ...]

  // Opt-ins — DEFAULT FALSE on every one
  optInModelTraining: boolean("opt_in_model_training").default(false).notNull(),
  optInAdvertising: boolean("opt_in_advertising").default(false).notNull(),
  optInThirdPartyResearch: boolean("opt_in_third_party_research").default(false).notNull(),
  optInMarketingComms: boolean("opt_in_marketing_comms").default(false).notNull(),

  signedAt: timestamp("signed_at").defaultNow().notNull(),
  signedFromIp: text("signed_from_ip"),
  signedFromUserAgent: text("signed_from_user_agent"),

  // PPA Feb-2026 evidence requirements: identity verification + non-repudiation
  // for sensitive medical data. A simple email click is not sufficient on its own;
  // see the "Identity verification & non-repudiation" section below.
  identityVerificationMethod: text("identity_verification_method").notNull(),
  // 'authenticated_session' | 'gov_sso' | 'third_party_idv' |
  // 'in_person_clinician_attested' | 'video_session_recorded' |
  // 'verified_phone_otp' | 'signed_form_upload' | 'credit_card_match'
  identityVerificationEvidence: jsonb("identity_verification_evidence").notNull(),
  // Method-specific evidence: { idvProvider, idvTransactionId, otpVerifiedAt,
  // videoFileId, attestingClinicianUserId, signedFormFileId, ... }
  nonRepudiationMethod: text("non_repudiation_method").notNull(),
  // Same value space as above. Often equal to identityVerificationMethod, but
  // can differ (e.g., third-party IDV verifies identity, OTP-on-verified-phone
  // proves the click was them). Recorded separately so the audit trail shows
  // both legs explicitly.
  nonRepudiationEvidence: jsonb("non_repudiation_evidence").notNull(),

  // Revocation — withdrawal of consent
  revokedAt: timestamp("revoked_at"),
  revokedByUserId: varchar("revoked_by_user_id").references(() => users.id),
  revocationReason: text("revocation_reason"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_consent_records_student").on(table.studentId),
  index("idx_consent_records_active")
    .on(table.studentId).where(sql`revoked_at IS NULL`),
]);
```

Naming: deliberately not `consent_forms` — that table already exists, scoped per-program with a different shape (`schema-private.ts:1284`). The two coexist: `consent_forms` is the per-program ROI artefact (school-style consent forms attached to an IEP). `student_consent_records` is the data-collection consent at the student level.

### `students` — no new column

The minor-protection flag is derived at consent-signing time from `students.country` + `students.birthDate` via the per-country adapter, then frozen onto `student_consent_records.isMinorEnhancedProtection` + `enhancedProtectionRegime`. The gate doesn't change retroactively as the student ages — but a re-consent prompt fires when they cross out of the regime's threshold (e.g., a US student turning 13 ages out of COPPA into the standard FERPA framework).

### `student_share_invites` — legal basis

```ts
legalBasis: shareLegalBasisEnum("legal_basis").default("guardian_consent").notNull(),
// 'guardian_consent' | 'school_official' | 'roi'
```

`guardian_consent` is the existing path (default, conservative). `school_official` skips the guardian-approval step when the source institute is a school AND the target is acting as a school official under FERPA. Requires source-admin attestation in the source UI; admin attestation is enough — no parent involvement needed by FERPA. `roi` is a documented Release of Information for HIPAA-style flows; same approval path as `guardian_consent` but tagged for audit.

## Consent flow per origin

### 1. Parent creates student in family institute (the simple case)

Onboarding wizard inside `StudentModal` when `instituteType === 'family'`:

1. Identity step — name, birth date, country (default IL).
2. Guardian-self-identify step — pre-filled from creator's user record, parent confirms "Yes, this is me." Asks for TZ if not already on their user record. Asks for `isLegalGuardian` + `dualGuardianAcknowledged` checkboxes with the legal text.
3. Section 11 notice — full text scrollable, with the four required acknowledgement checkboxes. Disclosed third-party recipients listed inline.
4. Opt-in toggles — all four default unchecked, with descriptions.
5. Submit — creates student, contact, consent record in one transaction.

If the parent already has consent records for sibling students, offer to copy the disclosure choices forward. Each consent record is still per-student per-version.

### 2. Clinician creates student in clinic institute (the common case)

Per the Feb-2026 PPA position paper, an emailed link alone is **not sufficient** to consent for sensitive medical data — the workflow must establish both identity verification and non-repudiation. The clinician picks one of these supported flows in `StudentModal`:

- **Existing parent linkage** — clinician selects an existing parent user (linked via family institute or pre-existing `studentContacts` with `linkedUserId`). The parent is *already authenticated* into the clinician client, which provides session-bound non-repudiation. They sign in their inbox; identity verification piggybacks on the auth session + the gov-ID-on-file from their original onboarding (their family-institute consent record), if present.
- **In-person signing at the clinic** — parent visits the clinic, the clinician opens the consent screen on their device, the parent reviews and signs, the clinician attests via the clinician's own authenticated session that the signing person presented matching ID. `identityVerificationMethod = 'in_person_clinician_attested'`; the attesting clinician's `userId` is captured in the evidence jsonb.
- **Video session** — recorded video call where the parent shows their ID and reads the consent text aloud; recording stored in the clinic's record. `identityVerificationMethod = 'video_session_recorded'`.
- **Government SSO** (when available) — parent authenticates via MoE Sapakim (IL) / login.gov (US) / equivalent. The SSO assertion provides identity verification and the assertion's session-bound nature provides non-repudiation. `identityVerificationMethod = 'gov_sso'`.
- **Third-party IDV** (e.g., IDnow, Stripe Identity, Onfido) — parent uploads ID and selfie via vendor SDK; vendor returns a signed verification result that we attach as evidence. Combined with an authenticated session click on a magic link to the consent form, this supplies both legs. `identityVerificationMethod = 'third_party_idv'`.
- **Magic link + verified phone OTP** — clinician enters parent's name, email, and a phone number that the clinician attests is the parent's verified contact. Parent clicks the link, then enters an OTP sent to that phone. Combined, this is a defensible two-channel binding. `identityVerificationMethod = 'verified_phone_otp'`. **The clinic's audit-log entry includes the clinician's attestation that the phone was confirmed by an out-of-band channel** (typically: the phone number was already in the parent's existing record from prior contact with the clinic).

Plain email-link click is **not** an option. We can offer it as a "draft consent" mechanism — the parent reads the notice and indicates intent — but the consent record is not marked `signed` until one of the methods above completes.

`consent_pending` is a soft state, not an enum on `students`. Computed: a student is consent-pending if no active `student_consent_records` row exists for them. Block list (enforced at boundary helpers):

- AI processing on this student blocked
- Programs / reports / incidents — clinician can draft locally but not finalize/share
- Cross-institute share invites blocked
- AAC sessions blocked

### 3. School creates student in school institute

Same flow + verification options as the clinic case. School also gets the option to use `legalBasis: 'institutional_delegate'` on subsequent share invites, but the *initial* data-collection consent always requires the verification + non-repudiation methods above — FERPA does not exempt schools from informing parents about data collection; the school-official exception only loosens the consent requirement for sharing with vendors performing institutional services after the initial collection consent is in place.

## Identity verification & non-repudiation

Per the Feb-2026 PPA position paper for sensitive (medical) data, valid consent now requires both:

- **Identity verification** — the system has reasonable assurance that the consenting person is the legal guardian they claim to be.
- **Non-repudiation** — the system can prove later that this specific person clicked / signed / submitted, not someone else who got hold of a link.

These are two distinct legs and our schema captures them separately (`identityVerificationMethod` + `nonRepudiationMethod`). The same method can supply both legs (e.g., `gov_sso`), but in many flows they're different (e.g., third-party IDV supplies identity, an authenticated session supplies non-repudiation).

### Method-by-method evidence

| Method | Identity evidence | Non-repudiation evidence |
|---|---|---|
| `authenticated_session` | Prior onboarding's verified gov ID on the user's `studentContacts` row | Session token, IP, UA, signedAt timestamp |
| `gov_sso` | SSO assertion attributes (TZ from MoE, etc.) | SAML/OIDC assertion ID, issued-at, audience |
| `third_party_idv` | Vendor's signed verification result (provider, transaction ID, score) | Authenticated session click + IDV-bound token |
| `in_person_clinician_attested` | Clinician saw and attests to ID document | Clinician's authenticated user ID + their session at attestation time |
| `video_session_recorded` | ID document shown on camera; video file ID | Same recording captures the signing act |
| `verified_phone_otp` | Out-of-band-verified phone (clinician attests prior knowledge) | OTP entered within TTL bound to magic-link token |
| `signed_form_upload` | Wet-signed form scan; signature visible | Filename + hash + uploader's authenticated session |
| `credit_card_match` (COPPA-specific) | Name on card matches claimed parent name; transaction succeeded | Stripe/processor transaction ID |

### Acceptable combinations by regime

| Regime | Required combination |
|---|---|
| IL — sensitive medical data (PPA 2026) | Any one of the methods that supplies both legs, OR an explicit pair (e.g., `third_party_idv` + `authenticated_session`) |
| US — COPPA (under-13) | One of COPPA's enumerated "verifiable parental consent" methods: `signed_form_upload`, `credit_card_match`, `video_session_recorded`, `gov_sso`, `third_party_idv`. `verified_phone_otp` alone is NOT sufficient for COPPA |
| US — non-COPPA / IL — non-sensitive | Any method, including `verified_phone_otp` |
| EU — GDPR (sensitive Art. 9) | `third_party_idv`, `gov_sso`, `in_person_clinician_attested`, `video_session_recorded`, or `signed_form_upload` |

The per-country adapter returns the list of acceptable methods for the (country, regime, sensitivity) tuple. The wizard hides ineligible methods. The DB enforces the same list server-side at insert time.

### Future-proofing

The verification space is moving. Storing `identityVerificationMethod` as `text` (not enum) means adding a new method = data, not migration. A registry (`shared/legal/idv-methods.ts`) lists known methods + their per-regime eligibility; unknown methods are rejected at write time. Evidence is `jsonb` so each method's specifics live alongside the record without schema churn.

## Informed-consent notice content

Versioned static module: `shared/legal/consent-notices/{country}.ts` exporting one constant per locale per country per version. Hash is computed over the exact rendered text. Initial countries to cover: IL, US, then a generic "OTHER" fallback that uses the GDPR-derived superset (since GDPR Article 13 is roughly the strictest of the three regimes).

The structure of the notice is the same in every country — purpose, voluntariness, recipients, retention, rights. The wording, prescribed phrasing, and which rights apply differ. New countries are added by writing a new file and adding the country code to the supported list; no schema change.

Initial version `2026.04` (IL) content (paraphrased — final wording goes through legal review):

- **Purpose** — "We use this data to document SLP clinical sessions, track developmental progress, manage the AAC service, and enable communication tools for the student."
- **Voluntariness** — "You are not legally obligated to provide this data; however, the service cannot be provided without it."
- **Recipients** — concrete list, frozen onto each consent record:
  - Cloud hosting (AWS, region disclosed)
  - LLM providers actually used (Google Gemini Live, OpenAI Realtime — names depend on `aac_chat` LLM settings at signing time)
  - TTS providers (whichever vendor is currently configured)
  - Authentication provider (if SSO used)
  - Sub-processors transitively required for the above
- **Retention** — how long, when deleted
- **Rights** — access, correction, deletion, withdrawal of consent (revocation), complaint to PPA / FERPA officer

When the recipient list changes (new vendor, removed vendor), the consent text version bumps. Existing consent records remain valid for the recipients disclosed in their snapshot. New processing using a newly-added recipient requires re-consent. This is what `thirdPartyRecipients` jsonb is for: it freezes what was disclosed, so a later vendor swap is detectable as "this student has not consented to recipient X."

## Minor-protection gate

The per-country adapter (`shared/legal/minor-protection/{country}.ts`) returns the regime that applies to a given (country, age) pair. Examples:

| Country | Regime | Threshold | Effect when applicable |
|---|---|---|---|
| US | `us_coppa` | < 13 | Verifiable parental consent required for non-essential processing; opt-ins for training / advertising / research / marketing forced off |
| EU member state | `eu_gdpr_minor` | < 13–16 (state-set) | Parental consent required for "information society services" — same opt-in restrictions |
| UK | `uk_ico_under13` | < 13 | ICO age-appropriate design code applies; opt-ins forced off |
| IL | `il_general` | < 18 (Legal Capacity Law) | Guardianship-based consent applies generally; opt-ins available but UI surfaces extra warning |
| OTHER (default) | `gdpr_superset_default` | < 16 | Treat as GDPR-strict until per-country adapter is added |

When the regime forces opt-ins off:
- The four opt-in toggles in the UI render as disabled with an inline explanation referencing the regime.
- The DB columns are forced to `false` server-side regardless of what the form submitted.
- A flag on the consent record records *that they were forced* (so future re-consent at age-out doesn't silently inherit the forced-off state).

Re-consent prompt: a daily cron queries for students whose age has crossed a threshold relative to the regime on their active consent record (e.g., a US student turning 13 ages out of `us_coppa` into the standard regime — opt-ins become legally available, parent should be re-prompted to choose). Cron emits `coppa_review_due` style audit events; the threshold name is the regime, not "coppa" specifically. Renamed to `minor_threshold_crossed` in the activity-event enum.

## Opt-in toggles — semantics

All four default off. Each is independent: revoking one doesn't revoke the others. The service must function fully with all four off — that's the test that they're truly opt-in and not coerced.

| Opt-in | Effect when ON | Effect when OFF (default) |
|---|---|---|
| `optInModelTraining` | Aggregated, de-identified data may be included in prompt-engineering / fine-tuning datasets | Student data never enters any training set |
| `optInAdvertising` | (None today — placeholder for future ad-supported tier) | Student data never used to target ads |
| `optInThirdPartyResearch` | De-identified data may be shared with research partners under DUA | Never shared for research |
| `optInMarketingComms` | We may email the parent about new features / case studies | Service-only emails (consent receipts, share notifications, security) |

## Share legal-basis tagging

On `student_share_invites.legalBasis`. Default `guardian_consent` keeps the existing flow. The two non-default values:

- **`institutional_delegate`** — the target institute is performing an institutional service under the source institute's direct control. FERPA calls this the "school official" exception; equivalents exist under HIPAA's "business associate" model and GDPR's "processor" relationship. The schema name is regime-neutral; the legal text shown to the source admin during attestation is the country-specific wording.
- **`formal_release_of_information`** — a documented release covering specific records, e.g. for HIPAA-style transfers where a written ROI is on file outside the system. Same approval path as guardian consent but tagged for audit and document linkage.

When a source-institute admin selects `institutional_delegate`:

- The `pending_guardian` state is **skipped** — guardian approval is not required.
- The source admin must attest, in a confirmation step, that the target institute meets the regime's criteria (institutional service / direct control / legitimate purpose). Attestation text snapshot + admin user is logged in the audit entry.
- The bundle is restricted to educational/operational records. Medical/behavioral incidents marked `is_sensitive` and `sensitivity_category = 'medical'` are excluded from `institutional_delegate` shares regardless of country.
- The audit entry's `details` field captures `legalBasis`, the attestation text version + hash, and the regime that applies (so a later auditor can reconstruct what the admin attested to).

This is purely a permissive shortcut — the existing guardian-consent path keeps working and is always available. We never *require* institutional-delegate; admins can always default to guardian consent for safety.

## Revocation

Revoking a `student_consent_records` row sets `revokedAt` and triggers cascade effects:

- The student returns to `consent_pending` state.
- All active `object_shares` and `standing_shares` for this student are auto-revoked (existing methods called in a transaction). Each cascade revocation logs its own audit entry with `details.cascade_reason: 'consent_revoked'`.
- Active AAC sessions are terminated.
- The student can re-consent under a new record — the revocation is a withdrawal of the prior signature, not a deletion of the data.

Data-deletion request (separate from revocation, as required by both PPA and CCPA/COPPA) is a different workflow handled by `studentService.deleteStudent` plus right-to-be-forgotten plumbing — not in scope for this plan.

## Audit logging

New `activity_event_type` values:

- `consent_signed`, `consent_revoked`, `consent_re_signed` (when a new version replaces an old one without revocation gap)
- `guardian_id_verified` (whenever `governmentIdVerifiedVia` flips from null to a non-null value)
- `minor_threshold_crossed` (system event, fires when a student ages out of an enhanced-protection regime — re-consent prompt due)

New `activity_subject_type` value: `consent_record`.

Subject1 = student, subject2 = consent_record, `details` jsonb captures `consentTextVersion`, `country`, `enhancedProtectionRegime`, the four opt-in states, `legalBasis` (for share-related events).

## Migration plan

### Step 1 — Additive

```sql
-- Enums (kept small and country-agnostic; per-country specifics live in code, not enums)
CREATE TYPE government_id_type AS ENUM ('national_id','passport','driver_license','other');
CREATE TYPE id_verification_source AS ENUM ('manual_entry','gov_sso','third_party_idv');
CREATE TYPE share_legal_basis AS ENUM ('guardian_consent','institutional_delegate','formal_release_of_information');

-- users additions (general profile fields, not consent-specific)
ALTER TABLE users
  ADD COLUMN country text,
  ADD COLUMN phone text,
  ADD COLUMN phone_verified_at timestamp;

-- studentContacts additions
ALTER TABLE student_contacts
  ADD COLUMN government_id_number text,
  ADD COLUMN government_id_type government_id_type,
  ADD COLUMN government_id_country text,
  ADD COLUMN government_id_verified_via id_verification_source,
  ADD COLUMN government_id_verification_provider text,
  ADD COLUMN government_id_verified_at timestamp,
  ADD COLUMN is_legal_guardian boolean DEFAULT false NOT NULL,
  ADD COLUMN co_guardian_acknowledged boolean DEFAULT false NOT NULL,
  ADD COLUMN legal_guardian_declared_at timestamp;

-- New table — country/regime fields are TEXT so adding support is data, not migration
CREATE TABLE student_consent_records ( ... );

-- studentShareInvites tagging
ALTER TABLE student_share_invites
  ADD COLUMN legal_basis share_legal_basis DEFAULT 'guardian_consent' NOT NULL;

-- Activity log
ALTER TYPE activity_event_type ADD VALUE 'consent_signed';
ALTER TYPE activity_event_type ADD VALUE 'consent_revoked';
ALTER TYPE activity_event_type ADD VALUE 'consent_re_signed';
ALTER TYPE activity_event_type ADD VALUE 'guardian_id_verified';
ALTER TYPE activity_event_type ADD VALUE 'minor_threshold_crossed';
ALTER TYPE activity_subject_type ADD VALUE 'consent_record';
```

### Step 2 — Backfill / grace period

Existing students predate this plan. Two-phase backfill:

1. **Mark all pre-existing students as `legacy_consent_grace`** — a dated flag (timestamp on `students.legacyConsentDeadline`, default now + 90 days). During the grace window, existing students function normally. Inside the admin UI, surface a banner per legacy student prompting whoever has a parent linkage to collect consent.
2. **After deadline**: legacy students without a consent record drop into `consent_pending`. Same blocks apply as for new students. Admin can extend per-student deadlines.

This avoids a hard cutoff that would brick current users; it puts pressure on completing the back-collection without breaking workflows day-of.

### Step 3 — UI rollout

`StudentModal` changes can ship before the grace window expires; the model accepts `consent_pending` states gracefully. Plan UI work in three phases mirroring the share-system rollout:

- **Phase 1**: schema + backend write paths + magic-link service (no UI yet for new students; backfill UI for legacy students).
- **Phase 2**: `StudentModal` consent wizard for the family-institute creator path (the simplest origin).
- **Phase 3**: clinician/school flows + parent inbox surface + magic-link redemption page.

## UI surfaces to add or extend

- `StudentModal.tsx` — consent wizard steps when creating a student (family path inline; clinic/school path triggers parent-side flow).
- `StudentInfoPanel.tsx` — display current consent status, version, opt-in states; "request re-consent" affordance for clinicians; "revoke" for parents.
- New component `ConsentInbox.tsx` (or extend `ShareInboxBell`) — pending consent requests in the parent's clinician-client inbox.
- New page `/consent/sign?token=...` — magic-link landing for parents without an account.
- `client/src/i18n/*.ts` — full informed-consent notice text in all supported locales (legal review per locale).

## Boundary helpers

Mirror of the visibility helper pattern from the sharing plan:

```ts
// server/services/consent/consentGate.ts
export async function requireActiveConsent(studentId: string): Promise<void> {
  // Throws ConsentError if no active consent record exists.
  // Called at every PHI write boundary, AAC session init, and share-invite create.
}

export async function getConsentSnapshot(studentId: string): Promise<ConsentSnapshot | null> {
  // Returns the active consent record's frozen disclosures + opt-ins.
  // Used by AI processing path to decide whether model-training opt-in is set, etc.
}
```

These hook into existing boundary helpers (`buildClinicianCtx`, `buildSessionAccessCtx`) rather than being parallel choke points — the consent check runs after access is granted, before processing happens.

## Open questions

- **MoE SSO timing**: do we wait for Sapakim onboarding to finish before shipping any of this, or ship the manual path first and bolt MoE on as a verification source later? Recommendation: ship manual path first. Sapakim integration is independently scoped in `ministry-of-education-integration.md` and gated by vendor approval that may take months.
- **Consent text legal review**: who signs off on the per-jurisdiction wording? Owner needs to be named before drafting begins.
- **Where does TZ get encrypted**: confirm we have a column-level encryption pattern; if not, this plan adds one. The `biometricData` table (`schema-private.ts:526`) is the closest precedent — check what it does today.
- **Magic-link TTL**: 7 days seems right but worth a security review. Cap re-issuance at 3 per request to prevent enumeration.
- **SMS provider selection**: `users.phone` and `users.phone_verified_at` columns shipped (migration `0084_mighty_daredevil`). `server/services/smsService.ts` has a `ConsoleSmsProvider` placeholder — logs instead of sending. Picking a real provider (Twilio, Vonage, MessageBird) is deferred until we actually need to send. Switch is via `SMS_PROVIDER` env var; provider classes plug into the existing `SmsProvider` interface so callers don't change.
- **OTP verification bypass for dev/test**: `smsService.isVerificationBypassEnabled()` returns true when `SMS_VERIFICATION_BYPASS=true` (refuses in production). When the consent flow checks this and accepts a phone-OTP consent without round-tripping, the consent record's `nonRepudiationEvidence` must carry `{ bypassed: true, reason: 'sms_not_configured' }` so audit can filter these out as non-binding. Remove the bypass once a real SMS provider is wired up.
- **Admin-attested IDV evidentiary weight**: license admins entering `governmentIdNumber` from off-band (invoice, intake call) gives us *something* but it's the weakest IDV path on the table. Acceptable for IL non-sensitive consent; questionable for IL sensitive medical consent under the Feb-2026 PPA paper. Decision: do we treat admin-attested as sufficient for the initial sign, with a follow-up upgrade to a stronger method (gov SSO once available, or third-party IDV) flagged in the consent record, or do we require a stronger method up front for sensitive flows?

## Out of scope

- Right-to-be-forgotten / data deletion workflow (separate plan, separate legal regime).
- Per-program consent forms (`consent_forms` table) — keep coexisting; they document program-level ROIs, not data-collection consent.
- Cross-border data transfer flagging (GDPR Article 44 / Israeli Section 36). The third-party recipient snapshot captures the names; explicit cross-border tagging can be added in a follow-up.
- MoE Sapakim integration itself — handled by `ministry-of-education-integration.md`. This plan only specifies the surface where MoE assertions land (`governmentIdVerifiedVia: 'moe_sso'`).

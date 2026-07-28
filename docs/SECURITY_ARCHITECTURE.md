# Aivota / CliniAACian — Security Architecture

This document describes how the platform handles sensitive data — identification, classification, storage, encryption, access control, audit, retention, sub-processors, breach response, and vulnerability management. It is **regime-neutral** (HIPAA, GDPR, FERPA, IL Privacy Protection Law, IL MoE, US Section 508, etc.) and reads through the `shared/regime/` registry for defaults that vary per jurisdiction.

For AWS infrastructure detail (VPC, IAM, KMS, ECS vs Lambda, WAF, CloudTrail) see [`INFRASTRUCTURE.md`](INFRASTRUCTURE.md). This document focuses on the **application and data layer**.

> **Audience:** internal security review, regulator reviewers (Israel MoE Sapakim, Experis pen-test team, EU/US data-protection authorities), and incoming sub-processors.

## 0. Versioning

| Field | Value |
|---|---|
| Last updated | 2026-05-06 |
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

The PHI/PII tables in `shared/schema-private.ts` (55 tables total) include:

- **Students & care team:** `students`, `aacSettings`, `biometricData`, `studentContacts`, `userStudents`, `instituteStudents`, `studentClassrooms`
- **Health & education:** `medicalRecords`, `functionalReports`, `educationalReports`, `programs`, `profileDomains`, `baselineMeasurements`, `assessmentSources`, `goals`, `objectives`, `userGoals`, `userObjectives`, `services`, `serviceGoals`, `serviceUsers`, `accommodations`, `progressReports`, `goalProgressEntries`, `dataPoints`, `incidents`, `transitionPlans`, `transitionGoals`, `programContacts`, `meetings`
- **Consent & verification:** `consentForms`, `studentConsentRecords`, `consentInvitations`, `phoneOtpCodes`
- **AI & memory:** `chatSessions`, `deepAnalyses`, `persons`, `personChatRooms`, `personChatRoomParticipants`, `personChats`, `personChatPushTokens`, `boards`, `customApps`, `customAppAssignments`
- **Files & integrations:** `dropboxConnections`, `dropboxBackups`
- **Sharing & invites:** `inviteCodes`, `inviteCodeRedemptions`, `studentShareInvites`, `objectShares`, `standingShares`, `studentSymbolAssociations`
- **Auth & ops:** `users`, `passwordResetTokens`, `mfaRecoveryTokens`, `activityLogs`

The schema split is enforced by file convention. Public-schema tables (`schema.ts`) carry no PHI; private-schema tables (`schema-private.ts`) require a typed `accessCtx` for reads.

### 1.3 Identification numbers & redaction

Israeli Teudat-Zehut (national ID) is treated as write-only with `[REDACTED]` returned on read. The pattern is documented at [`memory/project_id_number_redaction.md`] and applied in the institute-student schema and AI prompts (see `server/services/memory-schema/` redaction helpers).

## 2. Data Flow Diagrams

Each flow represents one end-to-end path with the components involved and the data that moves between them.

### 2.1 Authentication / SSO

```
Browser ──HTTPS──> ALB / Lambda URL ──> Express
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
- **WS ticket (iPad only):** the Capacitor shell keeps its session cookie in the native cookie store, which a WKWebView-issued handshake cannot reach, so it presents a ticket minted by `POST /api/aac/live/ws-ticket` (itself session-authenticated). Tickets are HMAC-SHA256 signed with a key derived from `SESSION_SECRET`, TTL 60 s, single-use, and carry only a user id — no PHI, no session id, and not exchangeable back into a session. The user record is still loaded on redemption, so a deleted or disabled account cannot connect. See `server/services/realtime/ws-ticket.ts`.
- **Provider selection** at session init from `system_settings` `aac_chat` LLM config; provider rows can rotate without code changes.
- **No raw audio at rest:** PCM frames flow through the live relay only. Transcripts are persisted in `chatSessions`/memory schema after redaction.
- **Monitor agent:** read-only on PHI; it can write to low-security memory categories (notes, observations) but not to medical records or goals. Gating is in `server/services/memory-schema/aac-memory-schema.ts`.
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
- **Identity verification:** consent operations gate on `IdvMethod` (in `shared/legal/idv-methods.ts`) chosen per regime — `verified_phone_otp` for sensitive medical (IL Privacy Protection Authority, Feb-2026), `gov_sso` when SSO is configured, `signed_form_upload` as fallback.

### 2.4 Consent and minor-protection

```
Clinician initiates onboarding ──> SendConsentRequestDialog
        │                                   │
        ▼                                   ▼
  consentInvitations             SMS (SNS) or Email (Resend) ──> Guardian
        │                                                            │
        │                                       phone_otp_codes      │
        │                                       <─verify──────────── │
        ▼                                                            ▼
  studentConsentRecords ── stamped recipients (recipients.ts) + IDV methods + minor-protection regime
```

- **Files:** `server/services/consent/`, `shared/legal/`.
- **Regime selection:** `shared/legal/minor-protection.ts` chooses one of `us_coppa | eu_gdpr_minor | uk_ico_under13 | il_general | gdpr_superset_default` based on the institute's regime + child age.
- **Recipients snapshot:** the third-party list shown at sign time is stamped into `studentConsentRecords.recipients` so audit can prove what the parent was told. Updates to the canonical list (`shared/legal/recipients.ts`) bump the consent-notice version; existing consents remain valid for *their* snapshot; new processing using a newly-added recipient requires re-consent.

### 2.5 Audit logging

```
Any cross-institute PHI read ──> recordShareDerivedView ──> activityLogService.log
                                                                     │
                                                                     ▼
                                                              activity_logs (Postgres)
                                                                     │
                                                                     └─ retention per regime (§7)
```

```
AWS API call ──> CloudTrail ──> S3 (KMS encrypted) ──> 6-year retention
Network flow ──> VPC Flow Logs ──> CloudWatch ──> S3 (KMS encrypted)
Application stdout ──> CloudWatch Logs (redacted; no query bodies, no PHI)
```

- The application audit log (`activityLogs`) covers user-driven PHI reads.
- AWS CloudTrail covers infrastructure operations.
- DB query bodies are NOT logged (HIPAA-safe). Only connections, disconnections, and DDL.

## 3. Storage and Residency

| Component | Service | Region (current) | Encryption | Notes |
|---|---|---|---|---|
| Application database | RDS PostgreSQL | `il-central-1` | KMS at rest, TLS 1.2+ in transit, `sslmode=require` | Multi-AZ in production |
| Object store | S3 (uploads) | `il-central-1` | KMS customer-managed | Tag `DataClass=PHI`; versioned |
| Object store | S3 (logs, backups) | `il-central-1` | SSE-S3 (AES-256) | Glacier transition after 90 days |
| Cache / pub-sub | ElastiCache Redis | `il-central-1` | At-rest + in-transit | Ephemeral; no PHI |
| Secrets | AWS Secrets Manager | `il-central-1` | KMS | IAM-controlled |
| Static frontend | S3 + CloudFront | global edge (S3 in `il-central-1`) | TLS 1.2+ | No PHI in static assets |

### 3.1 Residency policy

The `complianceRegimes` field on `LicensePermissions` (license JSONB) declares which regimes apply to an institute. Each regime carries a `requiresInCountryResidency` flag in the registry (`shared/regime/regimes.ts`). Today the entire deployment is in `il-central-1`. Multi-region partitioning per regime is **not yet** implemented; if a regime requires residency outside Israel (e.g., GDPR-strict tenants), the deployment plan is to spin up a region-scoped instance and route by institute regime at the load-balancer / DNS layer.

### 3.2 Two deployment paths

Terraform supports **Lean** (current; cost-optimized) and **HIPAA-compliant** paths. The Lean path uses Lambda + S3 + CloudFront; the HIPAA path uses ECS + private VPC + multi-AZ RDS + KMS-customer-managed everywhere. See `terraform/lean.tfvars` vs. `terraform/terraform.tfvars` and the comparison in [`INFRASTRUCTURE.md`](INFRASTRUCTURE.md).

## 4. Encryption

### 4.1 In transit

- **Public ingress:** TLS 1.2+ (CloudFront / ALB enforce). HTTP→HTTPS redirect.
- **Internal:** ECS↔RDS uses TLS (`sslmode=require`); Lambda→RDS same. WS upgrade is over the same TLS channel.
- **Provider APIs:** All outbound HTTPS (Gemini, OpenAI, Anthropic, ElevenLabs, Stripe, Resend, SNS, Dropbox).

### 4.2 At rest

- **Postgres:** RDS encryption with KMS.
- **S3 uploads:** KMS customer-managed key.
- **Secrets Manager:** KMS.
- **CloudWatch Logs / S3 Logs / CloudTrail:** KMS.

### 4.3 Application layer

`server/services/encryption.ts` provides AES-256-GCM with a 32-byte key derived from `ENCRYPTION_KEY` via `scrypt`. Output format: `IV:authTag:ciphertext` (hex). Used for fields that are sensitive even within the database:

- `users.mfaSecret` (TOTP shared secret)
- `users.mfaRecoveryCodes` (hashed)
- `identityProviders.clientSecret` (OIDC/OAuth2 client secret)
- `identityProviders.samlSpPrivateKey` (when SAML SP signs AuthnRequests)
- `phoneOtpCodes.codeHash` (hashed; never stored plain)
- `dropboxConnections.accessTokenEncrypted`, `refreshTokenEncrypted`

`ENCRYPTION_KEY` is fetched from Secrets Manager at runtime; never in source, never in environment files committed to the repo.

### 4.4 Redaction

- **Teudat Zehut on read:** institute student `idNumber` returns `[REDACTED]` placeholder. See [`memory/project_id_number_redaction.md`].
- **Logging:** `console.log` calls are reviewed not to include claim payloads or query bodies.
- **AI prompts:** PHI memory-schema reads pass through redaction helpers before being concatenated into prompts.

## 5. Authentication and Authorization

### 5.1 Local authentication

- Email + password, password hashed with `bcrypt` (`bcryptjs`); registration uses cost 12, password reset currently uses cost 10 — **open item:** unify on cost 12 minimum or migrate to `argon2id`. Password reset via `passwordResetTokens` (single-use, short-TTL, hashed at rest).
- Session cookies (`express-session`), `Secure` + `HttpOnly` + `SameSite=Lax`. Session table in Postgres.

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
- **Admin principal:** system admins; reads tracked separately.

Memory-schema operations and PHI controllers gate every read through this context. Documented at [`memory/project_ai_access_ctx.md`].

### 5.5 Family/cross-institute access scoping

Access checks key off the **selected** institute, not all institutes the user is in. A user who switches institutes loses share-derived access until the new institute has its own grants. Documented at [`memory/feedback_family_access_scoping.md`].

## 6. Audit Logging

### 6.1 Application audit (`activity_logs`)

Schema: `event_type, subject_type1/id1, subject_type2/id2, instituteId, userId, details JSONB, createdAt`.

- **Cross-institute reads:** every share-derived PHI read (cross-institute) fires `view`. Owned reads are not logged.
- **Share lifecycle:** `created`, `guardian_approved`, `redeemed`, `accepted`, `declined`, `revoked`, `expired` for `studentShareInvites`; `granted` / `revoked` for `standingShares`.
- **Consent lifecycle:** `consent_signed`, `consent_revoked`, `consent_re_signed`, `guardian_id_verified`, `minor_threshold_crossed` for `studentConsentRecords`.
- **Auth events:** `auth_login_success`, `auth_login_failure`, `auth_logout`, `auth_mfa_challenge`, `auth_mfa_success`, `auth_mfa_failure`, `auth_password_reset_requested`, `auth_password_reset_completed`. Logged with IP and user-agent in `details` for forensics; failures log `attemptedEmail` instead of `userId` (privacy-preserving).
- **Erasure lifecycle:** `student_erasure_requested`, `student_erasure_cancelled`, `student_erasure_completed`. Exempt from retention pruning (compliance evidence — see §6.3).

### 6.2 Infrastructure audit

- AWS CloudTrail: every API call, including S3 object-level operations. KMS encrypted, multi-region, log file validation enabled.
- VPC Flow Logs: all network metadata.
- ALB access logs: HTTP request metadata (no bodies).

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

**Current implementation:** S3 audit logs retained 6 years (covers HIPAA + IL); CloudWatch logs 90 days (cost trade-off, acknowledged in INFRASTRUCTURE.md).

The application `activity_logs` retention cron (`server/services/activityLogRetentionCron.ts`, `runActivityLogRetentionCheck`) is implemented and tested. It runs daily, scans every institute, and deletes rows older than `resolveAuditRetentionDays(institute regimes)` per row's institute (or the strictest known retention for orphan / `instituteId IS NULL` rows). It is wired into `server/index.ts` (long-lived Express path, used by the planned ECS deployment and dev) and skipped under `NODE_ENV=test`.

**Compliance-evidence exemption:** rows with `event_type IN ('student_erasure_requested', 'student_erasure_cancelled', 'student_erasure_completed')` are never pruned — they outlive every retention window because they prove we honored a right-to-erasure request. The exempt set is exported as `ERASURE_AUDIT_EVENT_TYPES` from `studentErasureService.ts`.

**Production-Lambda gap:** today's production stack uses the cost-optimized Lambda deployment path. `setInterval` doesn't fire reliably in Lambda (containers freeze between invocations), so `app.lambda.ts` does not invoke the cron scheduler. Until the planned ECS cutover, no production prune runs. We accept the resulting over-retention as a deliberate trade-off: it is conservative under every regime (we keep rows longer than the minimum, never shorter). The remediation pattern when ECS lands is straightforward (the long-lived process boots the cron at startup, same as `index.ts` already does); an EventBridge-scheduled cron Lambda is the alternative if Lambda is kept past ECS cutover.

## 7. Sub-processors

Canonical list lives at `shared/legal/recipients.ts`. The list is stamped onto `studentConsentRecords.recipients` at sign time so consent records are immutable.

| Category | Vendor | Purpose | Region |
|---|---|---|---|
| `cloud_hosting` | Amazon Web Services | Application hosting and encrypted-at-rest data storage | `il-central-1` (current) |
| `llm_provider` | Google Gemini Live | Realtime AAC interaction, clinician chat (when configured) | EU/US (Google-managed) |
| `llm_provider` | OpenAI Realtime / Anthropic Claude | Realtime AAC interaction, clinician chat (when configured) | US |
| `tts_provider` | Google Cloud TTS, ElevenLabs | Speech synthesis for AAC voice output | US |
| `auth_provider` | Google OAuth (when used) | Federated authentication | US |
| `auth_provider` | External IdPs (e.g. IL MoE Sapakim) | SSO via SAML/OIDC | per IdP |
| `sub_processor` | AWS SES / SNS, Resend | Transactional email & SMS, OTP delivery | varies |
| `sub_processor` | Stripe / RevenueCat | Billing (when applicable) | US |
| `sub_processor` | Dropbox (per-user opt-in) | File backup at user request | US |

Adding a sub-processor:
1. Update `shared/legal/recipients.ts`.
2. Bump consent-notice version.
3. Re-consent flow runs for new processing involving the new vendor; existing consents remain valid for their snapshot.

## 8. Backup, DR, Retention

- **RDS automated backups:** 35 days production / 7 days staging. Multi-AZ in production.
- **S3 versioning:** enabled on PHI bucket; lifecycle to Glacier after 90 days.
- **Redis:** ephemeral; no backup needed (no PHI).
- **PITR:** RDS continuous backup supports point-in-time recovery within retention window.
- **Disaster recovery:** RTO ≤ 4h (re-deploy from infrastructure-as-code; restore RDS from snapshot). RPO ≤ 5m (RDS continuous WAL archiving).
- **User data deletion:** GDPR/IL/COPPA "right to erasure" flows implemented at the institute or guardian level; cascade is documented in the consent system but not automated end-to-end (manual admin step pending).

## 9. Incident Response

### 9.1 Detection

- CloudWatch alarms (CPU/memory/5xx, RDS health, Lambda errors, low storage). See `INFRASTRUCTURE.md` for thresholds.
- GuardDuty (when enabled).
- Application alerts: failed login surges, unusual share-grant patterns (planned).

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

1. **Page** on-call engineer (CloudWatch → SNS → email/SMS).
2. **Contain** — disable the affected component (revoke creds via Secrets Manager rotation, scale down to halt processing if needed).
3. **Assess** — identify scope, data class affected, regimes implicated.
4. **Notify** — within the shortest applicable window: regulator(s), affected users (via guardian if minor), institute coordinators.
5. **Remediate** — fix root cause; rotate any leaked secrets; revoke any leaked tokens.
6. **Post-mortem** — write up cause + corrective actions; attach to compliance evidence file.

Notification templates live at `server/services/incident-templates/` — three regimes (PHI breach, security breach, vendor incident) × two locales (en, he), filled at send-time via `incidentTemplateService.fillIncidentTemplate(...)`. The templates are reviewed-once-by-counsel; the service substitutes incident-specific facts into `{placeholder}` tokens. See `incident-templates/README.md` for the inventory and review process.

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

- **OWASP Top 10** — input validation (Zod at every controller boundary), output encoding, parameterized queries (Drizzle), CSRF (allowlist-checked Origin/Referer middleware globally on non-GET routes; SSO `state` token on OIDC; SAML `RelayState` token on SAML), HSTS / X-Frame-Options / X-Content-Type-Options / Referrer-Policy via `helmet`. CSP is deferred until per-domain directives are tuned (Vite HMR + Google AI + S3 + WS).
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
- `planning-docs/student-consent-onboarding-plan.md` — consent system rationale
- `planning-docs/cross-institute-sharing-plan.md` — share system rationale

## 12. Open Items (tracked, must be closed before regulator submission)

1. 🟡 **Application audit-log retention:** code complete (`activityLogRetentionCron.ts`, 5 integration tests), wired into `index.ts` for long-lived Express. Production-Lambda invocation is **deferred to ECS cutover** — `setInterval` doesn't fire reliably in Lambda, and we accept conservative over-retention until the long-lived process is the production path. See §6.3 for the trade-off rationale. If Lambda is retained past ECS cutover, switch to an EventBridge-scheduled cron Lambda (Terraform: add `aws_cloudwatch_event_rule` targeting a new lambda whose handler calls `runActivityLogRetentionCheck()` and `runStudentErasureSweep()`).
2. **Multi-region residency:** all infrastructure is in `il-central-1`. EU/US tenants requiring local residency need a region-routing layer.
3. ✅ **Right-to-erasure automation (2026-05-07):** soft-delete + scheduled hard-delete pipeline shipped. `studentErasureService.softDeleteStudent` tombstones the student (sets `deletedAt` / `scheduledHardDeleteAt`, revokes user_students + institute_students links, revokes object/standing shares), with a 30-day default cancellation window (`STUDENT_ERASURE_WINDOW_DAYS` env var). `studentErasureCron` sweeps daily and physically cascades through ~25 PHI tables in a single transaction. After the DB commits, the cron also deletes the linked biometric face image from S3 (`s3Service.delete`); failures are surfaced via `result.s3KeysFailed` so ops can drive a manual bucket cleanup, but the DB delete is not rolled back. Admin endpoints under `/api/admin/students/:id/erase[*]`. Audit events `student_erasure_{requested,cancelled,completed}` are exempt from retention pruning.
4. ✅ **Login event audit (2026-05-06):** `authController` writes 8 auth event types (`auth_login_success`, `auth_login_failure`, `auth_logout`, `auth_mfa_challenge`, `auth_mfa_success`, `auth_mfa_failure`, `auth_password_reset_requested`, `auth_password_reset_completed`) to `activity_logs` with IP + user-agent in `details`. Failure rows log `attemptedEmail` instead of `userId` for privacy. Migration `0097_fast_molecule_man` added the enum values.
5. ✅ **Incident notification templates:** committed to repo at `server/services/incident-templates/` (3 types × en/he, filled via `incidentTemplateService.fillIncidentTemplate`). Initial scaffold landed 2026-05-07; first counsel review still pending.
6. **Per-institute breach contact:** institutes don't currently store a designated breach-notification address; today we contact the institute admin email.

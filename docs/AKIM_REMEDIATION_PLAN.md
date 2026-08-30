# AKIM annex — remediation plan (engineering)

**Created:** 2026-08-30
**Companions:** `docs/AKIM_ANNEX_RESPONSES.md` (what we tell AKIM),
`docs/AKIM_COMPLIANCE_ASSESSMENT.md` (what is actually true today).

This plan covers only what engineering can close. Items owned by legal, business
or the user are listed at the bottom so the boundary is explicit — they are not
tracked as work here.

## Already done (2026-08-30)

| Item | Annex clause | Where |
|---|---|---|
| RDS server-certificate verification | §4.1 | `server/db-ssl.ts` + `server/tests/db-ssl.test.ts` |
| CA bundle corrected to AWS **global** (was us-east-2 only, prod is il-central-1) | §4.1 | `rds-ca-bundle.pem` |
| RDS log retention 30 → 180 days | §5.8 | `terraform/ecs-lean.tfvars` |
| `alert_email` populated (`cs@aivota.ai`, own variable) | §6.1 | `ecs-lean.tfvars`, `hipaa.tfvars` |
| Stripe + Dropbox added to the disclosed recipient list | §5.3 | `shared/legal/recipients.ts` |

> Both Terraform changes apply automatically on the next merge to `main`
> (`deploy.yml` runs `terraform apply -auto-approve`). The SNS subscription
> e-mail goes out on that apply and needs one click to leave
> `PendingConfirmation`.

---

## Wave 1 — makes the signed commitments real

### 1. Incident-response pipeline — §6.1–6.6 *(annex "חריגים ודיווחים")*

**The gap.** We commit to: verbal + written notice within **48 hours**, an
investigation report within **3 days** of the event ending, and forwarding
data-subject requests within **72 hours**. Today
`incidentTemplateService.fillIncidentTemplate` is a string formatter with **no
production caller**, there is no register of incidents, and nothing starts a
clock. `shared/regime/regimes.ts` already exposes
`resolveBreachNotificationHours()` — nothing calls it either.

Note `incidents` in `shared/schema-private.ts` is the **clinical/behavioural**
per-student table. It is not a breach register and must not be overloaded into
one.

**1a. Register + service — ✅ DONE 2026-08-30.**
- `security_incidents` + `security_incident_events` (append-only timeline) in
  `shared/schema.ts`; migration `drizzle/0168_aberrant_steve_rogers.sql`
  generated via `npm run db:generate`. Audit vocabulary added to
  `activityEventTypeEnum` / `activitySubjectTypeEnum`.
- `server/services/securityIncidentService.ts` — open / update / note /
  recordNotification / recordInvestigationReport / close / listOverdue, every
  transition mirrored into `activity_logs`.
- `server/services/security-incident-deadlines.ts` — the deadline POLICY, split
  out so it is testable without a database. Deadlines are frozen at open time
  and stored, never re-derived on read: a later change to the regime registry
  must not rewrite the deadline an incident was actually held to.
- Tests: 21 DB-free (`server/tests/security-incident-deadlines.test.ts`) +
  18 DB-backed (`server/tests/integration/security-incident.test.ts`).
  All 39 pass; `tsc` clean.
- Not yet wired to anything — opening an incident is currently a code call.
  That is 1b and 1c.

**1b. Dispatcher + deadline watch — ✅ DONE 2026-08-30.**
- `server/services/securityIncidentDispatcher.ts` — the caller
  `incidentTemplateService` never had. Renders the counsel-reviewed template
  with facts derived from the register row, sends, then stamps the clock.
  Two refusals are the point of the file: **an unfilled template is never
  sent** (a customer must never receive "{remediation_summary}"), and **the
  clock is only stamped for a message that actually went out** — a failed send
  keeps the obligation overdue.
- `server/services/securityIncidentSweepCron.ts` — warns before a deadline and
  again when one is blown, writing each finding to the incident timeline. The
  timeline doubles as the de-duplication key, so an hourly sweep does not
  produce an hourly alert for the same obligation.
- Registered in `maintenanceCrons.ts` at an **hourly** interval — the cron
  framework only supported daily, which cannot protect a 48-hour window.
  `MaintenanceCron.intervalMs` was added for this.
- `server/services/operationalAlert.ts` — the alert e-mail shell, extracted
  from `providerAlertService` (which had the only copy) so both channels share
  one implementation.
- Tests: 6 DB-free + 16 DB-backed, 61 passing across the whole incident suite;
  `tsc` clean.

> ⚠️ **Test-safety note for whoever extends this.** The test environment carries
> live SES credentials (`.env`), so the delivery and alert paths take injected
> senders (`deps.sendMail`, `deps.alert`). A test that omits them will send a
> real breach notification or a real on-call alert. The existing tests never
> call the default sender; keep it that way.

**1c. Surface — ✅ DONE 2026-08-30.**
- New admin section `security-incidents` (`shared/admin-sections.ts`),
  deliberately a separate permission from `admins`: whoever is on call for a
  breach is not necessarily whoever manages backoffice accounts.
- `server/controllers/securityIncidentController.ts` + routes under
  `/api/admin/security-incidents` (all writes CSRF-validated).
- `client/src/components/admin/SecurityIncidents.tsx` + `useSecurityIncidents`
  hook, wired into `AdminDashboard`, `AdminSidebar` and `App.tsx`.
- 65 i18n keys inserted via `scripts/i18n-insert-keys.ts` with real en + he
  values; the other 9 locales are English-seeded and marked `// TODO-i18n`.
  `npm run validate-i18n` clean.
- Tests: 14 DB-backed controller tests; 75 passing across the incident suite.

Two design points worth keeping:
- **Preview then send.** The notify endpoint dry-runs by default and only
  sends on an explicit `dryRun: false`; the UI shows the Send button only
  after a preview has come back with no unfilled placeholders.
- **Refusals are 200-with-an-`outcome`, not HTTP errors.** The client's
  `apiRequest` discards the body of a non-2xx, so a 400 would reach the
  operator as the bare string "400" instead of the list of placeholders they
  still owe. Only a missing incident is a real 404.

> Fixed along the way: `scripts/i18n-insert-keys.ts` emitted hyphenated keys
> unquoted (`security-incidents: "..."`), which does not parse. It now quotes
> any leaf that is not a bare JS identifier.

**Why first:** this is the largest contractual exposure we can actually close
ourselves. Cross-border (§5) is bigger but is a legal instrument, not code.

---

### 2. Keep AKIM data out of staging — §5.11.5 / §5 (cross-border)

**What the investigation actually found (2026-08-30).** The original scoping —
"build a guard against production data reaching staging" — was wrong. There is
**no copy path**: the only two data-movement scripts (`copy-tables-to-prod.ts`,
`migrate-staging-to-prod.ts`) run staging → prod and treat staging as read-only.

The real exposure was the opposite. Staging's database is AWS RDS
`aac-test` in **us-east-2 (Ohio)**, and it was effectively production before the
ECS cutover, so real data was *created* there. `migrate-staging-to-prod.ts`
copied students to Israel but **excludes session and log tables by design**, so
conversation transcripts stayed behind. Cross-checking staging against
production by row id and by (student, timestamp) found 379 real-institute
sessions in Ohio with **zero** counterparts in production.

> This also explains an unrelated bug found the same day: `rds-ca-bundle.pem`
> held the **us-east-2** roots because it was generated for this database, and
> was never updated when production moved to `il-central-1`.

**Done (2026-08-30), with the user's per-account decisions:**
- **51 real-child sessions moved to production and deleted from staging** —
  Auerhahn (42, + 14 cost events) and ים סוחמי / שגיא / נועם / אביה וויס
  (9, + 355 cost events). New tool: `scripts/migrate-sessions-to-prod.ts`,
  dry-run by default. Every move was verified by **content hash** on both sides
  before the staging delete, not just by row count; the script refuses to delete
  unless production holds every row.
- **36,200 `session_debug_logs` purged** from staging. `activity_logs` (5,047)
  deliberately untouched — it is the audit trail with a §5.8 retention
  obligation, not debugging output.
- **5 external accounts disabled** on staging (raz.tenenbaum1, nauerhahn,
  lilitzysman1, Shellyp.physio, etalmon). Reversible; originals recorded in
  `planning-docs/staging-disabled-accounts-2026-08-30.json`.
- Left in place by decision: 248 sessions (Opher Suhami) and 80
  (רז טננבאום) — both confirmed testing accounts.

🚨 **Discovered while doing it: there was no working account-disable.**
`users.is_active` was written but never read — neither passport strategy
consulted it, and the Google strategy resolved an account by **email alone**,
checking neither password nor flag. Setting `is_active = false` blocked
nothing, in production as well as staging, contradicting our §2.8 answer that
revocation is "immediate and effective".

**✅ FIXED 2026-08-30** (`server/userAuth.ts`). One exported predicate,
`canAuthenticate()`, now owns the rule and is consulted at all four doors:
password login, Google-by-external-identity, Google-by-email, and
**`deserializeUser`** — the last of which is what makes revocation hit sessions
that are already open, rather than at cookie expiry. Verified safe before
shipping: nothing in the codebase writes `users.isActive = false`, and
production had **zero** inactive users, so no one is locked out by the change.
Tests: `server/tests/auth-is-active.test.ts` (10) — the predicate directly,
plus source-level pins on each of the four gates, since the original bug was
exactly that one door was missed.

**Admin accounts — ✅ closed 2026-08-30.** `admin_users` had no `is_active`
column at all, so the widest access in the system had no off switch. Migration
`0170_flimsy_lilith.sql` adds it (generated, not hand-authored), and the same
`canAuthenticate()` predicate now gates the admin password branch, the admin
Google branch and admin session deserialization. `PATCH /api/admin/admins/:id`
accepts `isActive`, refusing the case where an admin deactivates themselves and
leaves nobody able to re-enable them. Tests: 13 in
`server/tests/auth-is-active.test.ts`, including a source pin per door — the
original bug was exactly that one door was missed.

**Still outside Israel on staging:** 42 non-`[SIM]` students, 10
`medical_records`, 20 `biometric_data` rows, and ~3,800 sessions belonging to
test institutes and the two testing accounts. The biometric and medical rows
are the sharpest remaining category and have not been touched — they were never
in scope of what was authorised.

---

## Wave 2 — backs specific answers we wrote

### 3. Deletion certificate — §8.4 — ✅ DONE 2026-08-30
`server/services/erasureCertificateService.ts`. Builds the certificate from the
`student_erasure_requested` / `student_erasure_completed` audit rows and renders
it in English and Hebrew. Two rules are the point of the file:

- **Derived, never asserted.** No completion event → `ErasureCertificateNotAvailable`,
  not a document. We do not certify a deletion we cannot evidence.
- **It states the residual-copy window.** A hard delete is not instantaneous
  everywhere: RDS point-in-time recovery holds deleted rows for the backup
  window (35 days) and S3 keeps noncurrent versions for theirs (30). A
  certificate dated the day of deletion claiming the data is already
  unrecoverable would be **false on the day it is signed**, so it quotes the
  LONGER of the two windows and says whether it has elapsed yet. A test asserts
  the "permanently deleted" sentence is always followed by that qualification.

Tests: `server/tests/integration/erasure-certificate.test.ts` (10, passing).

**Exposed 2026-08-30:** `GET /api/admin/students/:id/erasure-certificate`
(`requireSystemAdmin`, `?locale=en` for English, Hebrew by default). Returns
**404** when no completed erasure is recorded — the absence of evidence has to
surface as an absent document, not an empty one.

### 4. Field-level change capture — §5.8 — 🟡 PARTIAL 2026-08-30
Extended `activityChanges.ts` from 2 tables to 6: added `medical_records`,
`functional_reports`, `educational_reports`, `student_contacts`, and wired the
three report update handlers in `reportController.ts` (each already loaded the
pre-update row for its access check, so no extra query).

**Widening coverage did not widen disclosure.** None of the new tables
contribute entries to `VALUE_SAFE` — their text columns are diagnoses, notes and
clinical narrative, so they reduce to presence exactly as before. What the log
gains is an accurate list of WHICH fields a clinician changed plus literal
values for boolean flags. Tests assert a diagnosis, a medication list, a
contact's phone number and the report narratives never appear in the payload
(`server/tests/activity-changes.test.ts`, now 27 passing).

**Still uncovered:** ~24 subject types have `eventType: "update"` audit rows and
only 6 tables have field capture. The care-plan tables (`goals`, `objectives`,
`programs`, `progress_reports` — 11 call sites) are the obvious next tranche;
each needs its own deny-by-default review rather than a bulk sweep.

---

## Wave 3 — larger, only if AKIM presses

### 5. Data-subject "produce" and "correct" — §9.4
Delete is fully automated; produce and correct are a managed manual process
today. A designated-record-set export plus an amendment request/denial flow.
Large. Fine at current scale, breaks with a few hundred service recipients.

### 6. Disaster-recovery evidence — §8
No restore runbook, no dated recovery drill, no cross-region snapshot copies.
`backup_retention_period` is the only implemented control. Medium, partly
infrastructure.

---

## Documents I can draft (unblocks legal — not legal advice)

### 7. DPA / TIA package for the three cross-border processors — §5.2–5.5
No DPA or BAA template exists in the repo. Draft the transfer-impact assessment
and the flow-down agreement skeleton for Gemini Live, Anthropic Claude and the
TTS providers, for counsel to review and execute.

### 8. Sub-processor retention facts — §8.5
We say sub-processors return or destroy data. Establish what Google, Anthropic
and ElevenLabs actually retain and for how long, and record it. If any of them
retains input, that has to appear in the §5.3 disclosure rather than be implied
away.

---

## Explicitly not engineering

| Item | Owner |
|---|---|
| AKIM written approval for cross-border processing (§5.1) | Business + AKIM |
| SCC execution, counsel review of liability (§5.6, §6.2, §7) | Legal + cyber insurance |
| External penetration test and certificate (§7) | Business — schedule with Experis |
| Named information-security trustee (§5.2) | User |
| Consent-notice version bump and re-consent | Legal decision, then engineering |
| Database registration / risk survey with the Privacy Authority (§10) | Legal |
| Whether biometrics and session recording are in scope at all | User |
| WAF / GuardDuty / CloudTrail profile switch | User — deferred on cost |

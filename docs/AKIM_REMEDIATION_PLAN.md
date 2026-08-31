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

## Wave 4 — assuming the `hipaa` profile is switched on (planned 2026-08-30)

Premise: `DEFAULT_PROFILE` flips to `hipaa`, which makes the WAF / GuardDuty /
CloudTrail / flow-log / 2192-day-retention answers true. What follows is what
the profile flip does NOT buy. Surveyed against the code on 2026-08-30; each
track is partitioned by file so it can run as an independent agent round.

### Track A — accounting of disclosures to processors — §18.5 / §14 — ✅ DONE 2026-08-30
**Shipped.** `server/services/processorDisclosure.ts` + `processor_disclosure`
rows (migration `0171`). Recorded INSIDE the six provider implementations
(claude/gemini/openai × structured/chat), not the factory — a fake provider in
the mocked-LLM suites must disclose nothing, and only the impl knows whether a
call went to Vertex or the public API (`details.endpoint`). Ids travel two
ways: an explicit `disclosure` field on `StructuredRequest`/`ChatRequest`/
`LiveProviderConfig`/`GPT` (closing the "DTOs carry no ids" gap), with an
AsyncLocalStorage context as fallback, entered at every session boundary
(coordinator `withSessionContext`, legacy relay, `sessionService`, deep
analysis, voice controller, summaries, captions, social bot, venue menus).
Gemini Live records the connect (the system prompt is PHI) and every
frame/audio/text send through the coalescer; TTS records at the branch taken,
before the attempt (a failed request already left); STT both engines.
Coalescing: one row per `(student, session, processor, useCase, channel)` per
5-minute window with `count`, flushed on the next send after expiry and on
`flushDisclosures()`; a fully idle process can lose only a trailing count,
never the fact. Unattributed sends write a `contextMissing` row straight
through and print `PROCESSOR_DISCLOSURE_CONTEXT_MISSING` once per
(processor, channel). `crm_chat` and `aac_sim` are declared non-PHI and
skipped explicitly, never by absence. 61 tests; every touched slice green.
The §18.5 report is `activityLogService.query({ subjectId, eventType:
"processor_disclosure" })` — no new endpoint.

**Gap (as found).** No `activity_logs` row is written when a transcript goes to Anthropic,
audio/video to Gemini Live, or text to ElevenLabs/Google TTS. The moment AKIM
grants §14 approval it acquires an interest in evidence of what actually
crossed the border, and we could not produce it. There is **no single choke
point**: four egress families (structured HTTP, streaming chat, Gemini Live
WS, raw Anthropic SDK in deep analysis) plus the TTS/STT facade, and none of
the request DTOs carry a student or session id.

**Design.**
- New event type `processor_disclosure` (migration `0171`). Subject = student,
  subject2 = chat session; details `{ processor, useCase, model, channel,
  count }`; `isAiInitiated: true`.
- `server/services/processorDisclosure.ts`: an AsyncLocalStorage disclosure
  context (`runWithDisclosureContext({studentId, sessionId, userId,
  instituteId, useCase}, fn)`) entered at the session boundaries (agent
  coordinator, legacy live relay, `sessionService` message handling, deep
  analysis run, voice controller), plus explicit `disclosure` fields where the
  ids are local (`LiveProviderConfig`, the TTS facade). Providers call
  `recordDisclosure(processor, channel, model)` at send time.
- **Coalesced**, not per-frame: one row per `(student, session, processor,
  useCase)` per 5-minute window with a `count`, otherwise a live session
  would write ten rows a second.
- **Fail loud.** A provider send with no context attached logs
  `processor_disclosure` with `subjectId1: null, details.contextMissing: true`.
  Coverage gaps become visible in the log instead of in an audit.
- Test pins each egress family; a source-level test asserts no provider
  `send` path lacks a `recordDisclosure` call.
- Read side: `activityLogService.query({ subjectId, eventType })` already
  answers "every disclosure about student X" — that IS the §18.5 report.

### Track B — provider allowlist + diagnosis gate — §14 — ✅ DONE 2026-08-30
**Shipped.** `shared/llm-policy.ts` — `PHI_PROCESSORS = { claude ✓, gemini ✓,
openai ✗ }`, every use case but `crm_chat` carries PHI (an unlisted future use
case is treated as PHI-bearing). Enforced at the admin write (400
`LLM_PROVIDER_NOT_PERMITTED`, nothing in a refused batch is written), at the
repository (`updateLLMConfig` asserts, so scripts hit the same wall), and at
resolution (`getLLMConfig` neutralises a violating stored row to the default
with a once-per-process `LLM_CONFIG_POLICY_FALLBACK` warning). Every config
write is an `update` row on subject `llm_config` with `{ from, to }`. Admin
models panel hides disallowed providers and shows the server's refusal.
Diagnosis: `diagnosis-for-prompt.ts` honours `allowReadReports`, writes a
coalesced `view` on `medical_record`/student (`route: aac.live-prompt.diagnosis`,
`isAiInitiated`), and `dual-agent-service.ts` no longer selects
`primaryDiagnosis` anywhere (source-pinned). Status rule: newest
non-`superseded` record, preferring `final` — a `final`-only filter was tried
and rejected because 7 of 9 staging records are `draft`. Tests 25 + 13 + 21.
Persona override and deep-analysis throw routed through the policy by Track A
(file ownership). Follow-ups: a violating `system_settings` row is neutralised
but not migrated, and the admin GET shows the default rather than the stored
value; the models panel is untranslated end to end (pre-existing).

**Gap (as found).** `getLLMConfig()` reads `system_settings` with no validation; the
"covered provider" rule is a code comment. An admin can route `aac_moderator`
to any provider. A per-persona override in `sessionService` bypasses even the
admin controller's checks. Separately, `dual-agent-service.ts:601/:621/:1039`
select `medical_records.primary_diagnosis` straight into the live-agent system
prompt — no `allowReadReports` check, no `status = final` filter, no audit row
— and the classroom roster path does it for every child on the device.

**Design.**
- `shared/llm-policy.ts`: `PHI_PROCESSORS` (claude ✓, gemini ✓, openai ✗ —
  the three names in the §5.3 disclosure) and `useCaseCarriesPhi(useCase)`
  (everything but `crm_chat`). `assertProviderAllowed(useCase, provider)`.
- Enforced at **write** (admin controller → 400 with reason) AND at
  **resolution** (`getLLMConfig` falls back to the use-case default and logs
  if a stored row violates policy — a setting written before enforcement must
  not keep routing PHI to an uncovered processor). Persona override and deep
  analysis go through the same function; the deep-analysis `throw` is replaced.
- Every `updateLLMConfig` writes an `update` row on subject `llm_config`
  (migration `0171`) with `{ from, to }` — a transfer-destination change is
  now visible.
- Diagnosis: honour `aacSettings.allowReadReports` (`!== false`, matching the
  column default), read only `status = "final"`, and record a `view` on
  `medical_record` / student with `details.route = "aac.live-prompt.diagnosis"`,
  `isAiInitiated: true`, coalesced per session. Roster path identical per child.

### Track C — field-level change capture, care-plan tranche — §5.8 — ✅ DONE 2026-08-30
`programs`, `goals`, `objectives`, `progress_reports` added to
`activityChanges.ts` (now 10 tables). All 11 call sites wired — 7 in
`programController.ts`, 3 in `progress-memory-schema.ts`; the fourth,
`set_objectives` (bulk list replace), deliberately stays a count because it has
no single before-row and a per-field diff would invent history the write does
not have. Activate/archive/achieve keep their `action` key and merge the
`status`/`achievedDate` transition.

Deny-by-default review as shipped: `VALUE_SAFE` holds only lifecycle enums,
dates and FK ids; every narrative column stays presence-only, and
`reportingPeriod` too (open text — nothing enforces "Q1"). `familyInput`
(parent-authored narrative) added to the `SENSITIVE_FIELDS.goals.log` tier.
`sortOrder`/`sequenceOrder` join `SKIP_FIELDS`. Tests: 17 new cases, each
redaction paired with `not.toContain` on the actual text; `activity` slice 85
passing, `program` 59, `progress` 19.

Still uncovered after this tranche: ~14 subject types with `update` rows and
no field capture (`service`, `accommodation`, `meeting`, `consent_form`,
`transition_plan`, `profile_domain`, …). Same recipe per table.

### Track D — dormant accounts, access review, user deactivation — §2.8 — ✅ DONE 2026-08-30
**Gap.** `users.lastActiveAt` moved only on fresh login; with 7-day cookies a
daily user showed a week-stale timestamp. Nothing listed dormant accounts.
`PATCH /api/admin/users/:id` did accept `isActive` but neither evicted
sessions nor audited the flip. `leaveInstitute` did not kill sessions where
`removeMember` does.

**Shipped.** Throttled 15-minute stamp in `deserializeUser` (fire-and-forget,
after the `canAuthenticate` gate — the 13 source pins still hold).
`access-review-policy.ts` (pure) + weekly `access-review` cron: dormant at 90
days; auto-deactivation OFF unless `DORMANT_AUTO_DEACTIVATE_DAYS` is set, and
never for `admin_users` or admin shell rows even then (all admins going dormant
would lock the last door). `GET /api/institutes/:id/access-review` (institute
admin; the review itself is logged as a `view`), `GET /api/admin/access-review`
(global). `PATCH /api/admin/users/:id { isActive }` now evicts sessions and
writes `{ isActive: {from,to} }`, refusing self-target. `leaveInstitute`
evicts like `removeMember`. Tests: 47 (24 policy + 23 integration), plus
`institute` 40 and `maintenance` 4. API only — no client lists `users`.
Follow-ups: `DORMANT_AUTO_DEACTIVATE_DAYS` needs a home in the env docs; no
test covers `leaveInstitute`; `users.last_active_at` has no index (weekly full
scan — fine at current volume).

**Design.**
- Throttled stamp in `deserializeUser` (row is already in hand; write only
  when older than 15 min) so `lastActiveAt` means what its name says.
- `server/services/access-review-policy.ts` (pure, DB-free tests): dormancy
  at 90 days for the review list; auto-deactivation OFF by default behind
  `DORMANT_AUTO_DEACTIVATE_DAYS` — disabling a clinician automatically is a
  product decision, the report is not.
- Weekly `access-review` maintenance cron: dormant users + admins to the ops
  mailbox via injected `alert` (live SES in `.env` — never the default sender
  in tests).
- `GET /api/institutes/:id/access-review` (institute admin): members, role,
  admin flag, last activity, reachable-student count, so §2.8's periodic
  review has something to review. `GET /api/admin/access-review` global.
- `PATCH /api/admin/users/:id { isActive }` with `deleteUserSessions` on
  deactivate; `leaveInstitute` gains the same session kill as `removeMember`.

### Track E — on-device session recordings — §13.5 / §17.2 — 🟡 purge/sweep DONE 2026-08-30; encryption UNDECIDED
Clips are plaintext WebM in the user's Videos folder; until today they were
pruned only when the recorder next ran and were invisible to erasure.

**Shipped.** Electron sweep timer (at start, then every 6 h, settings
persisted to `userData/recording-sweep.json`). Relay push
`purge_recordings { studentId, reason: erasure | device_revoked }` + ack
`recordings_purged { clipIds }`, sent from `softDeleteStudent` and device-slot
revocation via `recordingPurge.ts` through the live-session registry; the ack
writes a `delete` row on the student (`route: device.recordings_purged`,
`bestEffort: true` — an erasure certificate must never cite it as proof).
Client self-purge on a DEFINITIVE profile status only — **403** (tombstone
deactivates every link) or **404** (hard-deleted); **401 is excluded** because
an expired cookie or a server restart produces the same status and would
wipe a caretaker's footage. `softDeleteStudent` now evicts every AAC device
session for the child (a year-long device cookie kept PHI access to a
tombstoned student). Pure `planStudentPurge()` in
`shared/aac/session-recording.ts`: match by manifest `studentId`; orphans
(`studentId: null`, crash-recovered) only once past the retention window,
because deleting every orphan would destroy a different child's footage.
Tests: 32 + 11 + 22 (erasure, real rows) + client 18 + 8; `electron:build-main`
clean.

**Best-effort by construction, documented in code:** the device must be
listening (in-memory registry, one process); the legacy relay cannot be
pushed to; orphan clips are unattributable (fix is upstream — write the
studentId sooner). Found and left: `pruneExpiredDevices` reclaims a licence
slot on TTL expiry without revoking the cookie or requesting a purge.

**Decided 2026-08-30 (user):** the feature exists only for people involved in
advertising the company — it is not a customer feature. So instead of
encrypting clips at rest, it is gated on the licence: a real
`licenses.allow_session_recording` column (operator-granted, default false),
enforced on the settings write and on the student read the device fetches,
hidden from the AAC Settings panel unless licensed, and refused by the AAC
client regardless of cached settings. For AKIM this removes session recording
from table 3 for any customer whose licence does not carry the flag — which is
every customer.

**✅ Shipped 2026-08-30.** `licenses.allow_session_recording` (migration
`0173_many_loners`, one `ALTER TABLE`). It is a column and not a `permissions`
key for a mechanical reason: `resolvePermissions` expands `all: true` (the
admin form's "Grant All") to `MAX_LICENSE_PERMISSIONS` and system admins get
that object wholesale, so a key there would grant itself. One pure gate,
`applySessionRecordingLicense(raw, licensed)`, at three call sites: the
student read (both list and detail — an already-enabled row stops recording
with no write), both settings writers (silent force-off + warn, the
`ADMIN_ONLY_AAC_FIELDS` precedent), and the AAC client hook (`licensed` prop,
defence against a stale cached profile). Resolution walks the institute arm
AND the private-licence arm in two queries, deliberately bypassing
`getInstituteLicenseInfo` (it skips licences with a null `permissions` jsonb).
Admin toggle in `LicenseForm`, gated on the `"*"` wildcard permission —
NOT `isSystemAdmin`, which `adaptAdminAsUser` sets true for every admin
identity; a section admin gets 403 on the field and can still rename the
licence. Audited on the institute/user subject (no new enum value). Tests 52.
Owed: apply 0173 to staging/prod (never run `scripts/migrate.ts`
unilaterally); grant the flag to the marketing licence(s).

### Track F — data-subject produce / correct — §18.4 — ✅ DONE 2026-08-30 (API only)
**Shipped.** `data_subject_requests` (migration `0172`) with the 72-hour
forward deadline frozen at open; `dataSubjectRequestService` (open / forward /
decide / fulfil / withdraw, 409 on a refused transition); hourly
`data-subject-deadlines` sweep with restart-surviving dedupe on
`last_alert_kind` (escalation still fires because the kind changes);
`dataSubjectExportService` walking the SAME traversal as `_hardDeleteStudent`
plus the two tables erasure misses (`student_devices`, `custom_symbols`) —
deliberately, so the export and the delete are visibly out of step until
erasure catches up. Every walked table appears in the bundle even when empty,
so an absent table cannot be mistaken for a forgotten one. Withheld and NAMED
in `omitted`: biometric templates (`faceEmbedding*`, `voiceEmbedding*` — a
template is a credential), any column named `password|hash|token|secret`,
`sessions`, caretaker PINs, `activity_logs`, debug logs. Routes under
`/api/admin/data-subject-requests` + `GET /api/admin/students/:id/
data-subject-export`, `requireSystemAdmin`, CSRF on writes; fulfilment writes
the `export` audit row (`format: "dsr-json"`) before marking fulfilled. Tests
14 + 31. Retention: the request row itself is the evidence and is never
pruned; `export` rows were NOT exempted wholesale (that would exempt every
board/CSV export too). Follow-ups: no UI; no rate limit on the direct export;
intake runbook must say "no identity-document scans in `requesterDescription`".

**Plan (as written).** Greenfield. v1 is API + audit, no clinician UI:
- `GET /api/admin/students/:id/data-subject-export`: a JSON bundle that walks
  the same traversal as `_hardDeleteStudent` (direct → via programs → person
  facet) with presigned URLs for photo/biometric/symbol objects, filtered by
  the `SENSITIVE_FIELDS` registry so the bundle is the designated record set
  rather than a schema dump. Logged as `export` with `{ format: "dsr-json" }`.
- `data_subject_requests` table (kind produce|correct, target table/record/
  field, proposed value, decision, denial reason, statement of disagreement,
  72-hour forward-to-customer deadline frozen at open) — an amendment has
  state that does not fit tombstone columns. Endpoints under
  `/api/admin/data-subject-requests`, `requireSystemAdmin`.

### Track H — disaster-recovery evidence — §8 / §17 — ✅ TOOLING DONE 2026-08-30, drill NOT yet run
**Correction to the assessment:** cross-region snapshot copies are
contraindicated, not merely missing. `il-central-1` is the only Israeli region;
a copy anywhere else is itself a §14 transfer. DR stays in-region; region loss
is an accepted, documented risk whose fix is legal (approval + SCCs), not
Terraform. `AKIM_COMPLIANCE_ASSESSMENT.md` items 6 and the checklist corrected.

Shipped: `scripts/dr-restore-drill.ts` (`npm run dr:drill`; `--plan` default,
`--execute`, `--teardown-only`). Restores the newest automated snapshot into
`aivota-dr-drill-<stamp>` in-region with prod's subnet/SG/parameter group (so
`rds.force_ssl` applies to the copy), waits, tunnels via the bastion on port
15433 (5432 is refused — `db-tunnel` owns it), checks migration head against
`drizzle/meta/_journal.json` and row counts, measures the restore duration
(the empirical RTO component) and the snapshot-to-latest-row gap (observed
RPO), tears down with `--delete-automated-backups`, and writes
`docs/dr/drills/<date>-restore-drill.md`. Hard refusals: identifiers not
prefixed `aivota-dr-drill-`, deletions of anything not tagged
`Purpose=dr-drill`. Plan mode was verified against the live account read-only.
Runbook: `docs/DISASTER_RECOVERY.md` (RTO/RPO stated as **targets until a
drill file exists**; cutover is `aivota-prod/database` → ECS force-new-deploy,
not `app-secrets`). `docs/INFRASTRUCTURE.md` gained a pointer section.

**Owed by the user:** one `--execute` run (creates a `db.t3.micro` for ~an
hour), then commit the evidence file. Review first: the restore flag set,
`--delete-automated-backups`, and that the bastion→RDS SG rule is SG-scoped.

### Track G — Terraform hardening — ✅ DONE 2026-08-30 (user cleared it; the constraint was COST, not infra)
User ruling: every Terraform change is fine as long as it adds no billable
line item, and the deployment and `db-tunnel` flows keep working. Plan
verified against real state (read-only, never applied): 14 add / 7 change /
1 destroy (the superseded task-definition revision), **zero** replacements on
RDS, the ECS service, ALB, coturn, bastion, EIPs. Net new billable lines: zero.

**Shipped.** `terraform/ssm.tf` — `SSM-SessionManagerRunShell` logging shell
transcripts to the EXISTING logs bucket (no CloudWatch group; port-forwards
produce no transcript by construction — their evidence is CloudTrail
`StartSession`, on under `hipaa`; `db-tunnel.sh` names its own document and is
unaffected; session-level KMS deliberately off because it would break the
tunnel for anyone without `kms:GenerateDataKey`). ECS Exec off
(`enable_ecs_exec=false` — it never worked: no `ssmmessages:*` on the task
role). Task image pinned to the current digest for fresh applies
(`ecr_image_exists`). `readonlyRootFilesystem = true` in both ECS profiles
with a `/tmp` volume; every app-dir debug writer routed through
`file-debug-log.ts` (`safeAppend` never throws, memoises `EROFS`) and pinned
by `readonly-root-fs.test.ts` (44). **Found on the way:** `quest-game-log.ts`
imported the gate and never consulted it — the one writer still running in
production, appending raw clinician-chat memory values beside the bundle.
IAM DB auth on (additive; lands at the maintenance window), policy
`aivota-prod-rds-iam-connect` scoped to `aivota_engineer`. coturn: weekly
security patching Sat 00:00 UTC (03:00 IDT), image pinned `4.17.2`, host NOT
replaced (`ignore_changes = [user_data]`; bump `coturn_version` deliberately).
`copy_tags_to_snapshot`. ALB→task plaintext hop documented as a disclosure,
not changed.

**Found and fixed:** `monitoring.tf:32` referenced a `count`-gated bucket
unindexed since `c32a1a83` (2026-08-26, on `staging`) — `plan` failed for
every profile, so the FIRST merge of staging→main would have failed and taken
the whole HIPAA batch with it. (`main` is still `c672cf16` of Aug 25, which is
exactly what ECS runs — nothing has failed in production yet.)

**Deploy-role split (item E) — ✅ DONE 2026-08-31** (user approved). The
Terraform-managed `aivota-prod-github-actions-role` was repurposed in place as
the scoped deploy role: trust narrowed to `ref:refs/heads/main`, policy rebuilt
from ONE namespace list (24 services, derived from every resource type across
all three profiles plus every CLI call in deploy.yml — the old hand-written
list had drifted until it couldn't run the apply it existed for), S3 bounded
to `aivota-*`, IAM bounded to `aivota-*` roles/policies/profiles + PassRole to
the four service roles + `CreateServiceLinkedRole` (a `hipaa` switch mints
SLRs for ElastiCache/GuardDuty/WAF on first use), and an explicit Deny on
organizations/billing/IAM-user/access-key/login-profile actions. New read-only
`aivota-prod-github-actions-plan` role (trust `pull_request`; plan takes the
state lock, and a Deny blocks state writes). Plan delta: exactly 2 in-place
updates + 2 creates, zero other changes.

**Correction to the Phase 1 exposure claim:** no CI job runs on PRs at all —
`infrastructure` is gated `if: github.ref == 'refs/heads/main'`, and a PR's
ref is `refs/pull/N/merge`. So PR plans never ran and never obtained the
deploy role; the plan role has NO consumer until that `if:` is deliberately
relaxed (a one-line change, offered but not made — it would add a CI run that
does not exist today).

**Residual, stated not hidden:** the deploy role can rewrite its own policy
(it is an `aivota-*` role Terraform must manage); the control is that changes
land on `main` via review. A permissions boundary is the proper close.

**Rollout (user):** (1) merge — the apply still runs as the bootstrap admin
role and updates/creates the roles; (2) set repo secret `AWS_ROLE_ARN` to the
`github_actions_role_arn` output and add `AWS_PLAN_ROLE_ARN`; (3) KEEP
`cliniaccian-github-actions-bootstrap` untouched as break-glass — on a scoped
`AccessDenied`, repoint back, merge the fix (usually one namespace-list
entry), repoint forward.

**Owed by the user:**
1. ~~Local `terraform import` of the RDS log group~~ — **not needed any more
   (2026-08-31):** `deploy.yml` gained a "Terraform Adopt Pre-existing
   Resources" step (between Init and Plan, non-PR only) that imports
   `aws_cloudwatch_log_group.rds_postgresql` idempotently — already-in-state
   and not-in-AWS both fall through to plan/apply. There is no local
   terraform install; future same-class fixes are one `address=id` line in
   that step's list, replacing the old merge-fail-then-redeploy routine.
2. ~~One-time SQL for IAM auth~~ — **done 2026-08-31** at the user's request:
   `aivota_engineer` created on prod with `rds_iam` + DML-only grants
   (verified `member_of: {rds_iam}`). Token logins start working when the
   `iam_database_authentication_enabled` apply lands; attach
   `aivota-prod-rds-iam-connect` to each engineer's IAM identity.
3. ~~Decide on the deploy role~~ — decided 2026-08-31: scoped deploy role
   (repurposed in place, `main`-only trust) + read-only PR plan role, workflow
   falls back to `AWS_ROLE_ARN` until `AWS_PLAN_ROLE_ARN` is set; bootstrap
   admin role kept untouched as break-glass. Migrations 0171–0173 applied by
   the user the same day.

**Originally planned as:**
Unconditioned by profile: SSM Session Manager logging (zero today — every DB
port-forward is unlogged beyond the CloudTrail `StartSession` event); ECS Exec
enabled but the task role lacks `ssmmessages:*`, so it is a finding with no
benefit — grant or disable; task image `:latest` in Terraform while deploys are
sha-pinned; `readonlyRootFilesystem` (needs a `/tmp` volume and every
`*-debug.log` writer verified off in prod); OIDC trust `repo:IndigoFenix/aac:*`
(PR plans use the deploy role); `copy_tags_to_snapshot`; IAM DB auth; coturn
patch baseline + pinned image. Each is a `terraform apply` on the next merge
to `main` — held until the profile decision is made.

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

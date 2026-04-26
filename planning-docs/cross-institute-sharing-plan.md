# Cross-Institute Student Sharing — Architecture & Migration Plan

## Problem

A student in our system can legitimately need to be tracked by multiple institutes (e.g., a school AND a clinic). Today's `instituteStudents` junction table allows multi-institute attachment, but it grants undifferentiated visibility — every clinician at every attached institute sees every record. That fails FERPA/HIPAA (US) and Israel's Privacy Protection Law the moment a student crosses institutes.

See `legal-access-documents.md` for the lawyer's framing in full. Short version: **the unit of sharing is the object (program, report, etc.), not the student.** Each shared object is its own legally-distinct release of information.

## Architectural model

### Two access principals

All visibility queries route through one of two principals:

- **Institute principal** (clinician client): `WHERE institute_id = :currentInstituteId OR id IN (object_shares for this institute) OR student_id IN (standing_shares for this institute matching object_type)`
- **Student principal** (AAC client, OR family-institute escalation — see below): `WHERE student_id = :studentId`. Sees everything for that student regardless of `institute_id`.

The principal is bound to the **authenticated session**, not the client app. A clinician who somehow authenticates into the AAC client does NOT inherit student-context — that would be a back door past the institute filter.

#### Family-institute escalation (parent visibility)

FERPA (US) and the Israeli PPL both grant parents a non-waivable right to view records about their child. A parent who has selected a **family institute** in the clinician client must therefore see all PHI for any student attached to that family institute, regardless of which other institute owns each record.

The cleanest way to express this is at the boundary, not in the visibility helper. In `buildClinicianCtx(req, studentId?)`:

```ts
if (selectedInstitute.type === 'family'
    && userIsParentOrAdminOf(userId, studentId, selectedInstituteId)) {
  return { kind: 'student', studentId };  // family-institute admin acting as guardian
}
```

When the same user selects a non-family institute (e.g., they happen to be a clinician at a school as well), they get the institute principal for *that* institute — not student-equivalent access. The selected institute determines the role, consistent with the existing family-access scoping rule.

This escalation only applies when a `studentId` is in request scope (i.e., the endpoint is student-scoped). For institute-wide endpoints with no student in scope, family-institute principals get standard institute visibility.

### Three sharing mechanisms

1. **Default attach** via `instituteStudents`: grants identity-level visibility only (name, photo, age — directory information). PHI objects are hidden until explicitly shared.
2. **Per-object share** (`object_shares`): one row = one object visible to one target institute. Most cross-institute access flows through this. Each row IS the legal ROI for that object.
3. **Standing share** (`standing_shares`): match-by-pattern rather than match-by-id. Grants ongoing access to all current and future objects of specified types for a specific student. Used for AI-generated data (monitor notes, deep analyses, AI-recorded incidents) where new objects are created continuously and per-object consent is impractical. **Must have an expiry** (default 1 year, renewable).

### Three-party share-code handshake

Sharing requires consent from up to three parties; UI collapses clicks when one human plays multiple roles, but audit entries stay separate:

1. **Source** (owning-institute admin OR student/guardian for student-owned data): generates a time-limited share code, picks specific objects to bundle, sets share-expiry.
2. **Guardian**: reviews the bundle, approves (or declines, or de-selects items — never adds).
3. **Target** (target-institute admin): redeems the code, previews exactly what's being granted, accepts.

For student-owned objects (no source institute), the source-admin step is skipped — collapses to a two-party flow (guardian → target).

When source admin == guardian (e.g., source institute is the family institute), step 1→2 auto-approves with a separate audit entry for the auto-approval.

### Why standing shares are restricted to AI-generated types

The lawyer's framing requires per-object consent. Standing shares appear to bypass this — but they're authorized once by the guardian for a finite, well-defined object-type vocabulary, with mandatory expiry and revocation. They exist specifically because AI-generated objects spawn continuously during AAC sessions and each-one-consent is unworkable; manually-authored records (programs, formal reports) always go through per-object share.

## Table inventory

### Root PHI tables — `institute_id` nullable

| Table | Notes |
|---|---|
| `programs` | IEP/TALA root. Many child tables inherit owner via this. |
| `medicalRecords` | |
| `functionalReports` | |
| `educationalReports` | |

`institute_id` is nullable — backfill (school > clinic > family priority) covered most rows, but some students have zero institute memberships and their PHI rows remain NULL. NULL is not an error: those rows behave as student-only data and are visible only via the student principal (or family-institute escalation). Going forward, app-layer validation enforces `institute_id` at write time when a clinician creates these records, but the schema remains permissive for legitimate cases (test data, AAC-session-generated rows).

The original plan to tighten to NOT NULL post-backfill was dropped: orphan test data exists, and the same nullable pattern works uniformly across institute-owned and student-only data. The visibility helper handles both cases.

### Mixed-origin tables — `institute_id` nullable + standing-share eligible

| Table | Standing-share type | Notes |
|---|---|---|
| `incidents` | `incident` | Clinician-recorded → institute-owned. AI-recorded → null owner. Carries `is_sensitive` + `sensitivity_category` flags (see below). |
| `deepAnalyses` | `deep_analysis` | Always AI-generated; owner typically null. |
| `students.chatMemory` (Student_People / Interests / CommunicationStyle / Preferences / Notes) | `monitor_note` | Backed by the existing `chatMemory` jsonb column, populated by the AAC monitor agent during sessions. No separate table — `monitor_note` labels the AAC-observed dataset as a category, not a row set. Granting the share exposes those `Student_*` fields to the clinician AI and bridges to AAC-recorded incidents (see below). |

For these tables: `CHECK (institute_id IS NOT NULL OR student_id IS NOT NULL)`.

### Owned by assignment, not by object

| Table | Notes |
|---|---|
| `customAppAssignments` | The assignment of an app to a student is the PHI bit (reveals what tools a student uses). Apps themselves (`customApps`) are author-owned and reusable. |

### Tables that inherit ownership via parent FK (NO `institute_id` column)

Children of `programs`: `profileDomains`, `goals`, `objectives`, `services`, `accommodations`, `progressReports`, `transitionPlans`, `transitionGoals`, `meetings`, `consentForms`, `programContacts`, `userGoals`, `userObjectives`, `serviceGoals`, `serviceUsers`.

Deeper children: `baselineMeasurements`, `assessmentSources` (via `profileDomains`); `goalProgressEntries` (via `progressReports`); `dataPoints` (via `goalProgressEntries` / `goals` / `objectives`).

**Root-only ownership** is the chosen model: `institute_id` lives on root tables only; child queries join through to the root. Trades query speed for fewer ways to leak PHI through stale denormalized columns.

### Excluded from the share model entirely

| Table | Why |
|---|---|
| `chatSessions` | User-and-admin-only access. Visibility = `WHERE user_id = :currentUserId OR is_admin`. Stored for audit. Not shareable. The existing nullable `institute_id` column is informational (which institute context the session ran in) — NOT used for visibility. |
| `dataPoints` | Always inherit through goal/objective/program. AI-recorded data points get the program-owner's institute as ancestor — the school/clinic that owns the program sees them, others need a per-object share of the parent goal/program. |
| `boards`, `aacSettings`, `studentSymbolAssociations`, `studentContacts`, `biometricData` | AAC tools and identity data. Visible per the existing instituteStudents/userStudents model. Not records. |

### Out of scope

`users`, `instituteUsers`, `instituteInvites`, `instituteStudents`, `licenses`, `personas`, `voices`, `topics`, `userChat*`, `dropbox*`, `inviteCodes*`, `calendarEvents`, audit/system tables.

## Implications worth knowing

- **AI-generated data splits into two routes**:
  - Standalone, student-rooted (monitor notes, deep analyses, AI-recorded incidents) → standing-share eligible.
  - Anchored to a program (data points against a goal, AI-recorded incidents that reference a program) → inherits program owner; needs per-object share to cross institutes.
- **Standing shares are time-bounded by design** — a forgotten standing grant is exactly the access pattern HIPAA audits flag. Default 1 year, renewable.
- **Display attribution** — AI-generated content shown to a clinician must be visibly tagged as AI-observed, not styled as their own institute's clinical note. Otherwise AI observations drift into being treated as authoritative records.
- **Family access scoping** (existing rule, see `feedback_family_access_scoping.md`): all institute-context checks use the *currently selected* institute, never "any institute the user shares with the student."

## Sensitive-data flagging on incidents

FERPA/HIPAA categorize medical incidents (seizures, behavioral episodes, etc.) as "Sensitive Data" requiring extra controls. The existing `medicalRecords`, `functionalReports`, and `educationalReports` tables already carry `is_sensitive boolean` + `sensitivity_category sensitivity_category_enum`. `incidents` is missing the same pair and needs them added — both for consistency and for the legal-compliance gate.

Schema addition:

```ts
// in incidents
isSensitive: boolean("is_sensitive").default(true).notNull(),
sensitivityCategory: sensitivityCategoryEnum("sensitivity_category").default("medical").notNull(),
```

Default `is_sensitive = true` for incidents (most are medical/behavioral by their nature); recorders can toggle off for explicitly non-sensitive functional notes. The flag does NOT change the visibility rule itself — a sensitive incident is still visible to the same set of principals as a non-sensitive one. What it gates is the **share flow**:

- When a source admin tries to share an `is_sensitive = true` item, the share-flow service requires explicit confirmation in the source UI before generating the code ("This item is marked sensitive — confirm you want to share").
- The guardian's review screen highlights sensitive items distinctly so they're not approved by reflex.
- The share's audit-log entry records the sensitivity flag in `details` for HIPAA-style access reviews.

This is share-service UX, not visibility-helper concern — the helper stays uniform.

## Monitor-note semantics

`monitor_note` is the standing-share type that governs the **AAC-observed dataset**. Unlike other shareable types, it doesn't point at a single table — it labels a *category* of student-rooted data the AAC monitor agent produces. Granting `monitor_note` access to an institute exposes:

1. **The `Student_*` chat-memory fields**: `Student_People`, `Student_Interests`, `Student_CommunicationStyle`, `Student_Preferences`, `Student_Notes`. These are populated by the AAC monitor agent as it observes the student during sessions and live in `students.chatMemory` (jsonb). Without `monitor_note` access, these fields are dropped from the clinician AI's schema entirely at session-init time — the AI doesn't even know they exist (filtered in `sessionService.getMessageManager`).

2. **AAC-recorded incidents** — rows in `incidents` with `institute_id IS NULL`. These were recorded by the AAC client during a student-context session and are not owned by any institute. A clinician's `incident` standing share does **not** expose them — only `monitor_note` does. Clinician-recorded incidents (`institute_id` set) follow the standard `incident` rules (ownership + per-object share + `incident` standing share).

The bridging logic for incidents lives in `withIncidentVisibility` (see `server/services/sharing/visibility.ts`), which replaces `withInstituteVisibility(incidents, ctx, 'incident')` everywhere `incidents` is queried with a `ctx`. The chat-memory gating uses `canAccessMonitorNotes(ctx, studentId)` at session boundary.

Student / family-institute / admin principals bypass both gates (the AAC student is the subject; family-institute escalation grants student-equivalent access; admins bypass everything). Only the institute principal in the clinician chat is filtered.

## Privacy triangle (incident visibility)

For incidents specifically, the legal model is:

- **Creator org**: always sees it (their professional documentation). Handled by `institute_id` matching.
- **Parents/guardians**: must always see it (FERPA / Israeli PPL). Handled by family-institute escalation to student principal.
- **Other orgs**: nothing by default; only via explicit per-object share or standing share. Handled by the default visibility rule.

This triangle is the design target, and the architecture above implements it.

## Migration plan

### Step 1 — Additive (single migration)

```sql
ALTER TABLE incidents               ADD COLUMN institute_id varchar;
ALTER TABLE deep_analyses           ADD COLUMN institute_id varchar;
ALTER TABLE custom_app_assignments  ADD COLUMN institute_id varchar;

CREATE TABLE student_share_invites ( ... );
CREATE TABLE object_shares ( ... );
CREATE TABLE standing_shares ( ... );

ALTER TYPE activity_event_type ADD VALUE 'share_invite_created';
-- ... etc (see schema files for full list)
ALTER TYPE activity_subject_type ADD VALUE 'share_invite';
-- ... etc
```

### Step 2 — Backfill (separate migration)

```sql
-- Priority: school > clinic > family > earliest tiebreaker
WITH ranked AS (
  SELECT is.student_id, is.institute_id,
    ROW_NUMBER() OVER (
      PARTITION BY is.student_id
      ORDER BY CASE i.type
                 WHEN 'school' THEN 1
                 WHEN 'clinic' THEN 2
                 WHEN 'family' THEN 3
                 ELSE 4
               END,
               is.created_at
    ) AS rn
  FROM institute_students is
  JOIN institutes i ON i.id = is.institute_id
  WHERE is.is_active
)
UPDATE programs p SET institute_id = r.institute_id
FROM ranked r
WHERE r.student_id = p.student_id AND r.rn = 1
  AND p.institute_id IS NULL;
-- Repeat for medical_records, functional_reports, educational_reports.
-- Leave incidents, deep_analyses null (treat existing as student-owned;
-- testing-stage data, low volume — manual fixup if needed).
```

### Step 3 — Sensitivity flags on incidents (next migration)

```sql
ALTER TABLE incidents
  ADD COLUMN is_sensitive boolean DEFAULT true NOT NULL,
  ADD COLUMN sensitivity_category sensitivity_category DEFAULT 'medical' NOT NULL;
```

(Original Step 3 was constraint-tightening to NOT NULL on the four root PHI tables. Dropped — see "Root PHI tables" inventory section. CHECK constraints on `incidents` and `deep_analyses` were also dropped as redundant since `student_id` is already NOT NULL on both.)

### Step 4 — Visibility helper

Single canonical helper used by all repositories. Lives at `server/services/sharing/visibility.ts`:

```ts
export type AccessCtx =
  | { kind: 'institute'; instituteId: string; userId: string }
  | { kind: 'student'; studentId: string }
  | { kind: 'admin' };  // system admin bypass

export function withInstituteVisibility(
  table: { id: PgColumn; instituteId: PgColumn; studentId: PgColumn },
  ctx: AccessCtx,
  objectType: ShareableObjectType,
): SQL { ... }

// For child tables that inherit owner through a parent root.
export function withInheritedVisibility(
  childForeignKey: AnyColumn,
  root: { id: PgColumn; instituteId: PgColumn; studentId: PgColumn },
  ctx: AccessCtx,
  rootObjectType: ShareableObjectType,
): SQL { ... }

// Imperative single-object check.
export async function canAccessObject(
  ctx: AccessCtx, objectType: ShareableObjectType, objectId: string,
  studentId: string, ownerInstituteId: string | null,
): Promise<boolean> { ... }
```

Without the central choke point, the family-access scoping bug (already in memory) recurs across every endpoint.

The `ctx` parameter is **optional** on every repository read method. Legacy callers continue to work (no filter applied); migrated callers pass `ctx` to enable filtering. This permits incremental rollout across the ~20+ repository methods that touch PHI.

### Step 5 — Boundary helper for clinician requests

In `server/controllers/programController.ts` (and equivalent for each PHI controller):

```ts
function buildClinicianCtx(req: Request, studentId?: string): AccessCtx | undefined {
  const userId = (req.user as any)?.id;
  const instituteId = typeof req.query.instituteId === 'string' ? req.query.instituteId : undefined;
  if (!userId || !instituteId) return undefined;

  // Family-institute escalation: parents/guardians acting via family institute
  // see full PHI for their wards (FERPA/PPL compliance).
  if (studentId) {
    const inst = await instituteService.getInstituteById(instituteId);
    if (inst?.type === 'family'
        && await userIsParentOrAdminOf(userId, studentId, instituteId)) {
      return { kind: 'student', studentId };
    }
  }

  return { kind: 'institute', instituteId, userId };
}
```

The escalation only fires when a `studentId` is in request scope. Determined at the boundary, not in the helper, so the helper stays uniform.

## AI access (db-memory-bridge / memory-schema)

The AI reads and writes PHI through the same surface as the clinician UI: both ultimately hit Postgres. But the AI doesn't go through `programController` / `reportController` — it goes through `manageMemory` tool calls that route through `processMemoryToolWithDB` (in `server/services/chat/memory-db-bridge.ts`), which dispatches to per-field DB ops defined in `server/services/memory-schema/*`.

That makes the memory-schema layer a **second boundary** for the visibility helper, parallel to the HTTP controller boundary. If we don't gate the AI path, a clinician chatting in institute X about a student also attached to institute Y can have the AI surface Y's PHI unfiltered — same bug as the controller layer, different code path.

### Where AccessCtx enters the AI pipeline

The chat session has its own boundary helper, parallel to `buildClinicianCtx`:

- **`buildSessionAccessCtx`** in `server/services/sharing/sessionCtx.ts` — produces an `AccessCtx` from the session inputs (`userId`, `studentId?`, `instituteId?`, `isAACFeature`, `isSystemAdmin`). Same family-institute escalation rule as the controller helper.
  - AAC client → `{ kind: 'student', studentId }` (student principal — by design, AAC sees its own student's data regardless of institute)
  - System admin → `{ kind: 'admin' }`
  - Clinician selecting a family institute as parent/admin of `studentId` → `{ kind: 'student', studentId }` (FERPA/PPL escalation)
  - Otherwise → `{ kind: 'institute', instituteId, userId }`

The resulting `accessCtx` is stashed on `ChatContextManager.baseContext.accessCtx` and flows into every `DBOperationContext.all.accessCtx` via the existing `createDBContext(base, ...)` machinery. No change to the memory-bridge core; only the schemas need to consume it.

### Per-schema gating

| Schema | Tables touched | How gated |
|---|---|---|
| `incident-memory-schema.ts` | `incidents` | Forward `ctx.all.accessCtx` to `incidentRepository.listByStudent` / `getById` (already ctx-aware). |
| `reports-memory-schema.ts` | `medical_records`, `functional_reports`, `educational_reports` | Apply `withInstituteVisibility(table, accessCtx, type)` to current/archive reads. Cross-institute write rejection on the write op (institute principal cannot modify a record whose `institute_id` differs from `ctx.instituteId`). |
| `analysis-memory-schema.ts` | `deep_analyses` | Apply `withInstituteVisibility(deepAnalyses, accessCtx, 'deep_analysis')` to list/get. Read-only by design. |
| `progress-memory-schema.ts` | `programs` (root), 14 child tables | Apply `withInstituteVisibility(programs, accessCtx, 'program')` on `programOps.read`. Cross-institute write rejection on `programOps.write` for institute principals. Children inherit visibility through the parent program — no per-child gating needed (root-only ownership). |
| `student-custom-apps-schema.ts` | `custom_app_assignments` | Reads forward `accessCtx` to `customAppRepository` (already ctx-aware via `getAssignedAppIds`). Writes already validate the app is in one of the student's institutes; no further institute filtering needed. |
| `aac-memory-schema.ts` | medical/functional/educational/programs (read-only context) | No change. AAC is always the student principal — the existing `studentId` filter is the correct (and complete) scope. |
| `chat-context-integration.ts` | `medical_records`, `functional_reports`, `educational_reports` (parent `Context_Reports.read`) | Apply `withInstituteVisibility` on the parent loaders (`loadMedicalRecord`, `loadFunctionalReport`, `loadEducationalReport`) so initial population matches per-field reads. |

### Sensitive-flag and standing-share interaction with AI

- **AI cannot initiate shares.** `studentShareInviteService.createInvite` requires a human `createdByUserId` (source admin or guardian). The memory-schema layer does not expose share creation tools. This is intentional: AI-recorded objects can be granted via standing share, but the *grant itself* is a human consent transaction.
- **Sensitive flag** is read-only from the AI's perspective on `incidents` (default `true`). The AI doesn't toggle it.
- **AI-generated objects** (incidents recorded via memory tool, deep analyses, future monitor notes) carry `institute_id = null` when the caller is the AAC client, by design — they become standing-share-eligible student-rooted data. When the same object types are recorded from the clinician chat, they pick up `ctx.instituteId` from the institute principal so the owning institute sees them without a share.

### Write-side rejection in memory schemas

Mirror of `requireOwningInstitute` from `reportController`: when an institute-principal AI tries to update a PHI record whose `institute_id` differs from `ctx.instituteId`, the memory-schema write op throws. This prevents read-via-share from quietly upgrading to write-via-share. Same rule as the controller layer; centralizing it would be premature — there's only one such check per schema.

### Out of scope for the AI gate

- **AAC monitor agent's `preloadAllStudentContext`** — student-principal call by definition (the AAC student is the subject), no institute filter applies.
- **Program children** (goals, objectives, etc.) accessed via the AI — gated by the parent program's visibility, same as the repository-level gate.

## Audit logging

Reuse existing `activityLogs` infrastructure (`server/services/activityLogService.ts`). New event types:

- `share_invite_created`, `share_guardian_approved`, `share_redeemed`, `share_accepted`, `share_revoked`, `share_declined`, `share_expired`
- `standing_share_granted`, `standing_share_revoked`

New subject types:

- `share_invite`, `object_share`, `standing_share`

Subject1 = student, subject2 = invite/share record. `details` jsonb captures variable bits (target institute, scope, code-hash truncated for non-reversible audit).

## Open items for later

The v1 cross-institute sharing initiative is complete. See "Next session" below for the remaining minor follow-ups.

All share UI lives in the clinician client (including guardian-initiated flows via the family institute). The AAC client is the student's own communication tool and never surfaces share affordances.

## Implementation status

### Done
- Migration `0079_daily_ghost_rider`: enums (`share_invite_status`, `share_permission`, `shareable_object_type`), tables (`student_share_invites`, `object_shares`, `standing_shares`), `institute_id` columns on `incidents` / `deep_analyses` / `custom_app_assignments`, activity-log enum extensions.
- Migration `0080_backfill_institute_id_for_phi_roots`: school > clinic > family backfill on `programs`, `medical_records`, `functional_reports`, `educational_reports`. 14 students with zero memberships left NULL by design.
- Migration `0081_smooth_lily_hollister`: `incidents.is_sensitive` (default `true`) + `incidents.sensitivity_category` (default `'medical'`).
- `server/services/sharing/visibility.ts`: `AccessCtx`, `withInstituteVisibility`, `withInheritedVisibility`, `canAccessObject`, `visibleProgramIds`.
- **Boundary helper with family-institute escalation**: `buildClinicianCtx(req, studentId?)` is async — looks up institute type via `instituteService.getInstituteById`, verifies user membership + student-in-institute, and returns `{ kind: 'student', studentId }` when a family-institute admin/parent views their ward (FERPA/PPL parental rights). Otherwise returns the institute principal.
- **Cascade visibility into program children — every read on `programRepository` accepts optional `ctx`**:
  - Direct children gated via `withInheritedVisibility(child.programId, programs, ctx, 'program')`: `profileDomains`, `goals`, `services`, `accommodations`, `progressReports`, `transitionPlans`, `meetings`, `consentForms`, `programContacts`.
  - Grandchildren gated via subquery against the visible-programs set: `baselineMeasurements`, `assessmentSources`, `objectives`, `dataPoints` (by goal & by objective), `goalProgressEntries`, `transitionGoals`.
  - `getProgramWithDetails` threads `ctx` through every nested fetch.
- **Other root PHI repositories wired**:
  - `incidentRepository.{getById, listByStudent}` accept `ctx`.
  - `medicalRecordRepository`, `functionalReportRepository`, `educationalReportRepository` — `SecurityContext` extended with optional `accessCtx` field; visibility helper supersedes legacy `eq(institute_id)` when provided. Backwards compatible.
  - `deepAnalysisService.{getDeepAnalysis, listDeepAnalysesForStudent}` accept `ctx`.
  - `customAppRepository.{getAssignedAppIds, getAssignedAppsForStudent}` accept `ctx` (filters via `customAppAssignments.institute_id`).
- **`programController` endpoints fully wired**:
  - Reads (`getProgram`, `getProgramWithDetails`) re-fetch with `ctx` after the legacy `verifyProgramAccess` gate.
  - Writes (`updateProgram`, `activateProgram`, `archiveProgram`, `deleteProgram`) reject institute-principal modifications when `program.instituteId !== ctx.instituteId` — read access via share does NOT grant write. Cross-institute writes via `permission='write'` shares deferred.
- All type-clean.
- Migration `0082_good_rhino`: adds `student_share_invites.pending_bundle jsonb` (default empty bundle, NOT NULL) — captures what's being granted while the invite is in-flight, retained post-accept as the audit-grade snapshot of the consent transaction (frozen at grant-time, decoupled from later flag changes on underlying objects).
- New `ShareInviteBundle` type in `shared/schema-private.ts` describing the bundle shape: `{ objects: [{type,id,isSensitive}], standingTypes, permission, shareExpiresAt, standingExpiresAt, sensitiveAcknowledged }`.
- **Share state-machine service** — `server/services/sharing/studentShareInviteService.ts`:
  - `createInvite`, `approveByGuardian`, `redeem`, `accept`, `decline`, `revokeInvite`, `revokeObjectShare`, `revokeStandingShare`, plus list/read paths and `expireElapsedInvites` sweep.
  - **Role-collapse**: when `createdByUserId === guardianUserId`, auto-fires the guardian step inline with a separate `share_guardian_approved` audit entry (`details.autoApproved=true`).
  - **Sensitive-flag gate**: `enrichBundleWithSensitivity` queries `medical_records`, `functional_reports`, `educational_reports`, `incidents` (the four tables with `is_sensitive`), denormalizes the flag onto the bundle, and refuses creation when any item is sensitive without `bundle.sensitiveAcknowledged=true`. Throws `ShareInviteError("sensitive_unacknowledged", { sensitiveObjectIds })` so the UI can prompt then resubmit.
  - **State guards**: `transitionStatus(from, ...)` is conditional update — `WHERE id = ? AND status IN (?)` — so concurrent transitions from a stale state fail rather than corrupt. Materialization (`objectShares` + `standingShares` rows) happens only on `accepted`.
  - **Permissions**: source-admin OR guardian-of-student (when `sourceInstituteId` is null) can create; named guardian approves/declines pre-approval; target-institute admin redeems/accepts/declines post-redeem; source admin / guardian / target admin can revoke the whole invite; granular per-share revocation also supported.
  - **`ShareInviteError` codes** map cleanly to HTTP: `not_found` 404, `invalid_state` 409, `permission_denied` 403, `code_expired`/`share_expired` 410, `validation` 400, `sensitive_unacknowledged` 422.
- **Share-invite repository** — `server/repositories/shareInviteRepository.ts`:
  - 12-char codes from a 31-char unambiguous alphabet (~60 bits entropy); SHA-256 hash for unique-indexed lookup.
  - Plaintext code returned **once** on create (only the hash is persisted).
  - `materializeBundle` is the only caller that creates `objectShares` / `standingShares` rows — they don't exist before `accepted`.
- **Share API** — `server/controllers/shareInviteController.ts` + routes in `server/routes.ts`:
  - `POST /api/shares/invites` create
  - `GET /api/shares/invites?role=source|target&instituteId=...` list
  - `GET /api/shares/invites/inbox` guardian inbox
  - `GET /api/shares/invites/:id` fetch
  - `POST /api/shares/invites/:id/approve` (guardian)
  - `POST /api/shares/invites/:id/decline?by=guardian|target`
  - `POST /api/shares/redeem` (target submits code)
  - `POST /api/shares/invites/:id/accept` (target finalizes; materializes shares)
  - `POST /api/shares/invites/:id/revoke` (any party)
  - `POST /api/shares/object-shares/:id/revoke` and `…/standing-shares/:id/revoke` (granular)
- **Boundary helper extracted to shared location** — `server/services/sharing/clinicianCtx.ts` exports `buildClinicianCtx(req, studentId?)` (was previously inlined in `programController`). `programController` now imports it instead of duplicating.
- **Other PHI controllers wired through `buildClinicianCtx`**:
  - `incidentController.list` — `ctx` threaded into `incidentRepository.listByStudent`.
  - `deepAnalysisController.{get, list}` — wired. `get` does a no-ctx baseline fetch to derive `studentId`, then re-fetches with proper ctx (so escalation can fire).
  - `customAppController.getAvailableAppsForStudent` — passes ctx to `getAssignedAppIds`.

- **Report stack consolidated to canonical 3-layer split**:
  - `reportController` (access control) → `reportService` (business logic) → `reportRepository` (database access). Each layer has a single, well-defined responsibility.
  - `reportRepository` extended with optional `ctx?: AccessCtx` on every read method (medical/functional/educational by-id, by-student, current, archived; plus `getAllReportsForStudent` and `getCurrentReportsForStudent`). When `ctx` is set, the cross-institute visibility helper applies. When omitted (e.g. AI memory-db bridge — but it actually accesses tables directly via `db`, not through this repo), the unfiltered read is preserved.
  - `reportService` threads `ctx` through every read method.
  - `reportController` calls `buildClinicianCtx(req, studentId)` for student-scoped endpoints and uses the two-step pattern (no-ctx baseline → re-fetch with ctx after `studentId` is resolved) for by-id endpoints, so family-institute escalation works on both.
  - **Deleted dead parallel stack**: `recordsController.ts`, `recordsService.ts`, `medicalRecordRepository.ts`, `functionalReportRepository.ts`, `educationalReportRepository.ts`, plus the unused `SecurityContext` re-export. The previous session had been wiring these — they were never mounted in `routes.ts`. All routes go through `reportController`.
  - **AI memory-db bridge unaffected**: `server/services/memory-schema/reports-memory-schema.ts` queries the `medicalRecords`/`functionalReports`/`educationalReports` tables directly via `db` and drizzle ops — does NOT go through any repository. Confirmed zero usage of the deleted code.

- **`reportController` write paths hardened with cross-institute write rejection**:
  - New private helper `requireOwningInstitute(req, res, record, label)` — sends 403 and returns false when the caller is acting as an institute principal whose selected institute does not own the record. Student principals (family-institute escalation) and admin principals always pass.
  - Applied to all 12 modify-existing endpoints: `updateMedicalRecord`, `finalizeMedicalRecord`, `createMedicalRecordRevision`, `deleteMedicalRecord`, plus the parallel functional and educational endpoints.
  - For the 3 CREATE endpoints (`createMedicalRecord`, `createFunctionalReport`, `createEducationalReport`): the new record's `instituteId` is now **forced** to `ctx.instituteId` for institute principals (overriding any value supplied in the request body). Student principals retain the body's `instituteId` (legitimately null or family-institute owned). Eliminates the prior gap where a malicious caller could create a record under another institute's ownership by spoofing the body field.

- **Share UI Phase 1 — clinician client `SharesPanel` shipped**:
  - Added `'shares'` to `FeatureType`; route `/shares` registered in `App.tsx`; `FEATURE_TO_PATH` / `PATH_TO_FEATURE` / `FEATURE_CONFIG` extended.
  - `client/src/features/SharesPanel.tsx`: tabs for Outgoing, Incoming, Inbox. Lists invites with status badges, code-expiry, message preview, and revoke action. Dialogs in the same file: `RedeemDialog`, `AcceptDialog`, `GuardianApproveDialog`.
  - `client/src/hooks/useSharesApi.tsx`: `useShareInvites`, `useGuardianInbox`, `useShareInvite`, plus mutation hooks for create / approve / decline / redeem / accept / revoke. React Query invalidation on every mutation.
  - Sidebar: "Shares" nav item (Share2 icon) added in the Student Management section, reachable from the institute level (no student required).
  - i18n: full `shares.*` block (~85 keys) added to **all 11 locale files** in `client/src/i18n/`.

- **Share UI Phase 2 — rich create-share dialog shipped**:
  - Extracted to its own file: `client/src/features/sharing/CreateShareDialog.tsx`. Replaces the Phase-1 single-UUID input.
  - **Object picker**: pulls items from the current student's records via existing hooks (`useStudentPrograms`, `useAllReports`) plus inline queries for incidents and deep analyses. Grouped by type with icons (Stethoscope/Activity/GraduationCap/AlertTriangle/Brain/etc.), each row shows a label, a meta line (status / date), and a destructive "Sensitive" badge when the underlying record's `is_sensitive` flag is true.
  - **Guardian-contact selector**: dropdown sourced from `GET /api/biometric/students/:studentId/contacts`, filtered to contacts with a non-null `linkedUserId` (the invite schema requires `guardianUserId notNull` to FK into `users.id`, so unlinked contacts can't stand in as guardians). Falls back to a "no linked contacts — add one first" hint when the list is empty.
  - **Standing-share types section**: tabbed alongside the per-object picker. Restricted to `incident`, `deep_analysis`, `monitor_note` (the AI-generated stream types per the architecture doc). Standing-expiry input becomes mandatory and visible only when at least one standing type is selected.
  - **Sensitivity gate**: counts selected items with `isSensitive`, surfaces an inline destructive-styled box listing them and a checkbox the user must tick before "Generate code" enables. Server-side 422 `sensitive_unacknowledged` errors are caught in `onError` and surfaced via toast referencing the same checkbox copy.
  - **Submit guardrails**: button disabled unless studentId + sourceInstituteId + a guardian + at least one (object OR standing type) + standing-expiry-set-when-needed + sensitive-acknowledged-when-needed are all satisfied.
  - i18n: 9 new keys added in all 11 locales (`perObjectTab`, `standingTab`, `guardianContact`, `guardianContactPlaceholder`, `noLinkedContacts`, `shareExpiryDays`, `standingExpiryDays`, `standingDescription`, `noItems`). Validator: **0 errors**.

- **Share UI Phase 3 — header notification surface**:
  - New component `client/src/features/sharing/ShareInboxBell.tsx` — Bell icon mounted in `TopHeader` next to Settings. Polls `/api/shares/invites/inbox` every 60 seconds with `refetchOnWindowFocus: true`.
  - Renders a destructive-variant Badge with the pending count (capped to "9+"). Click invalidates the inbox query and navigates to `/shares` via `setActiveFeature('shares')`. Hidden on mobile (matches Settings/Logout pattern; mobile users reach Shares via the sidebar nav item).
  - **New-invite toast** — uses a `prevCountRef` initialised on first payload (not on mount) so an existing pending invite doesn't fire a toast on app load. When the count rises, fires a toast titled `shares.notifications.newInviteTitle` with body referencing the delta count.
  - i18n: 3 new keys added in all 11 locales (`notifications.bellLabel`, `notifications.newInviteTitle`, `notifications.newInviteBody`). Validator: **0 errors**.

- **Monitor-note read-access logging** — session-init audit entry:
  - When a clinician (institute principal) gains `monitor_note` access, `sessionService.getMessageManager` fires one `view` activity-log entry per session. Subject is the student (chat memory is keyed to `students.chatMemory`, no per-row id needed): `subjectType1='monitor_note'`, `subjectId1=studentId`, `subjectType2='student'`, `details={ viaShare: true, dataset: 'chatMemory' }`. The viewing institute is on the entry's `instituteId`.
  - **Granularity**: one event per session, not per field-access — per-field would be noisy and isn't what HIPAA reviewers want at this layer. The entry records "user X had AAC-observed access for student Y at time T," which is the right audit shape.
  - AI-recorded incidents continue to log via the standard `recordShareDerivedView` path (they're real rows in `incidents` with normal id/studentId/instituteId).

- **Monitor-note semantics finalized** — chat memory + AAC-recorded incidents:
  - **Reframing**: `monitor_note` no longer means "future dedicated table" — it labels the AAC-observed dataset as a category (chat memory + AAC-recorded incidents), with no separate table. Updated the table-inventory section in the plan accordingly.
  - **`canAccessMonitorNotes(ctx, studentId)`** in `visibility.ts` — boolean gate. Student/admin pass; institute principal requires an active `monitor_note` standing share for the student.
  - **`withIncidentVisibility(table, ctx)`** in `visibility.ts` — replaces `withInstituteVisibility(incidents, ctx, 'incident')` everywhere incidents are queried. Splits the standing-share clause: `incident` standing share covers only `institute_id IS NOT NULL` rows; `monitor_note` standing share covers only `institute_id IS NULL` rows. Per-object share and ownership still cover both.
  - **`incidentRepository.{getById, listByStudent}`** swapped to `withIncidentVisibility`. The AI memory schema picks up the change automatically (it routes through the repo).
  - **Session-boundary gating** in `sessionService.getMessageManager`: when `accessCtx.kind === 'institute'` and `canAccessMonitorNotes` returns false, drops the chat-memory `Student_*` fields (Student_People, Student_Interests, Student_CommunicationStyle, Student_Preferences, Student_Notes — exported as `STUDENT_CHAT_MEMORY_FIELD_IDS` from `student-memory-schema.ts`) from `MASTER_MEMORY_FIELDS` before passing to `createChatContextManager`. The AI never sees that surface absent the share.
  - **AAC mode unaffected**: student principal sees its own data unconditionally. Family-institute parents (escalated to student principal) see chat memory + AAC incidents for their child without a separate share — same FERPA/PPL pattern as elsewhere.
  - **`Student_CustomApps`** is excluded from the chat-memory set — it's backed by the assignments table and governed by `custom_app_assignment` access, not `monitor_note`.

- **Per-student rollup view in Active-shares** — collapsible cards by student:
  - **Backend**: `studentShareInviteService.listActiveSharesForInstitute` now also returns a `students` map (id → display name) computed via `students` table join across the union of student-ids touched by the active object/standing shares. Endpoint payload extended.
  - **Frontend**: `ActiveSharesList` re-grouped — outer cards keyed by student (sorted by display name), each card shows student label + total grant count, expanding reveals the per-object and standing share lists. Uses shadcn `Collapsible` (was already in `components/ui/collapsible.tsx`). Default-open so existing behaviour preserved for institutes with few students; collapsed view scales when there are many.

- **Audit `view` events for `incident`, `monitor_note`, `custom_app_assignment`** — enum extension + wiring:
  - **Migration `0083_clammy_purifiers`** adds `incident`, `monitor_note`, `custom_app_assignment` to `activity_subject_type` enum.
  - `incidentRepository.{getById, listByStudent}` now call `recordShareDerivedView` after the gated read returns.
  - `customAppRepository.getAssignedAppIds` projection extended to include `id`, `studentId`, `instituteId` so the audit helper has what it needs; also fires `recordShareDerivedView`.
  - `monitor_note` is in the enum but no dedicated table exists yet (see `aac-memory-schema.ts` notes) — wiring follows when the table lands.

- **Admin audit-log query UI** — `/admin/activity-log` extended for share lifecycle events:
  - The admin dashboard already had `ActivityLog.tsx` with filters (event type, subject type, date range, AI/human source). Filters now expose all share-related event types (`share_invite_created`, `share_guardian_approved`, `share_redeemed`, `share_accepted`, `share_declined`, `share_revoked`, `share_expired`, `standing_share_granted`, `standing_share_revoked`) and the new subject types (`share_invite`, `object_share`, `standing_share`, `incident`, `monitor_note`, `custom_app_assignment`, plus previously-omitted `custom_app`, `deep_analysis`, `program_contact`, `student_contact`, `biometric_data`).
  - `eventBadgeVariant` extended: revocations/declines/expirations render destructive, grants/redemptions/acceptances default, mid-flow steps secondary.
  - i18n: 9 new event-type labels (`admin.activityLog.eventTypes.share_*` + `standing_share_*`) added across all 11 locales.
  - **No backend work** — `activityLogService.query` already supports filtering by all of these; it was only the dropdown options that needed updating.

- **i18n reconciliation** — parallel landing-page work had drifted some locales (notably ru.ts had `landing.verticals` ↔ `landing.founder` reordered, plus other admin-block divergences). Rebuilt all 10 non-English locale files from en.ts as the structural source of truth, preserving the locale's existing translated values where present and falling back to English placeholders for anything missing. Validator: 0 errors (down from 547). Per-locale stats: ar/de/es/pt fully preserved; fr dropped 15 stale keys; he/ko/yue/zh/ru have small gaps (1–13 keys) where en.ts has new strings the locale never translated — those show English placeholders, matching the project's existing fallback pattern.

- **Renewal-expiry notification surface** — bell signals expiring standing shares:
  - `ShareInboxBell` now polls two endpoints (`/api/shares/invites/inbox` + `/api/shares/standing-shares/inbox`) and rolls them up into a single badge count. The inbox endpoint already exists from the renewal flow — no new backend work.
  - **Threshold**: `EXPIRY_NOTIFICATION_THRESHOLD_DAYS = 30`. The inbox-tab list still uses `RENEW_THRESHOLD_DAYS = 90` (panel surfaces shares earlier so guardians can plan; the bell only nags closer to expiry). Already-expired shares also count — renewal still works on those.
  - **Distinct toasts per signal**: separate `prevCountRef` per kind so a new pending invite fires `notifications.newInvite*` and a newly-expiring share fires `notifications.expiring*`. Click → `/shares?tab=inbox`, the unified surface for both.
  - **i18n**: 2 new keys (`notifications.{expiringTitle,expiringBody}`) in all 11 locales. Validator: 0 errors.
  - **No bell badge segmentation**: the badge is a single combined count. If the two signals diverge enough to warrant separate visual treatment (e.g. color by kind), a follow-up can split them; the data is already there.

- **Bulk-ungrant on student transfer** — guardian revokes all access to one institute in one click:
  - **Backend**: `shareInviteRepository.listActiveSharesForGuardianAtInstitute(userId, studentId, targetInstituteId)` joins object_shares + standing_shares through their parent invites and returns only the rows where `invite.guardianUserId === userId` and `revokedAt is null`. Service `bulkRevokeForGuardianAtInstitute` calls the existing single-revoke methods in a loop, so each grant fires its own audit entry — no special bulk event type. Concurrent revoke races are silently absorbed (already-revoked rows are skipped). Endpoint `POST /api/shares/bulk-revoke {studentId, targetInstituteId}` returns `{objectSharesRevoked, standingSharesRevoked}`.
  - **Frontend**: `useBulkRevokeShares()` mutation. `StandingSharesList` (Inbox tab) gets a "Revoke all" button per card alongside the existing Renew. Click opens `BulkRevokeDialog` — a confirmation modal explaining that *all* active shares (per-object + standing) granted to that institute for that student will be revoked. Toast on success reports the total count.
  - **i18n**: 5 new keys (`actions.revokeAll`, `bulkRevoke.{title,description,confirm,toastSuccess}`) across all 11 locales. Validator: 0 errors.
  - **No special event type**: each individual revoke produces its own `share_revoked` / `standing_share_revoked` activity entry. Audit trail stays per-grant — a bulk operation simply produces N entries clustered in time. If a "bulk_revoke" rollup is later wanted, it's a new event type + a wrapper log call.

- **Cross-institute share-visibility surface** — Outgoing/Incoming tabs now show materialized shares, not just invites:
  - **Backend**: 4 new repo methods (`listObjectSharesBySource/ByTargetInstitute`, `listStandingSharesBySource/ByTargetInstitute`); standing-share-by-source joins through the parent invite since `standingShares` has no `sourceInstituteId` column. Service: `listActiveSharesForInstitute(instituteId, role)` returns both kinds in one round-trip; only non-revoked rows. New endpoint `GET /api/shares/active?role=source|target&instituteId=...` wired in `routes.ts`.
  - **Frontend**: `useActiveShares(role, instituteId)` query + `useRevokeObjectShare` and `useRevokeStandingShare` mutations exposed from `useSharesApi`. `SharesPanel` Outgoing/Incoming tabs each split into two sections — "Invites" (existing list) and "Active shares" (new `ActiveSharesList`). Active shares are shown as compact rows grouped by per-object vs standing, each with permission badge, expiry, and a granular Revoke button (drops a single grant without touching siblings under the same invite).
  - **i18n**: 8 new keys (`outgoing.{invitesHeader,activeHeader}`, `incoming.{invitesHeader,activeHeader}`, `active.{objectSharesHeader,standingSharesHeader,noExpiry}`, `empty.activeShares`) added to all 11 locales. Validator: 0 errors.

- **Standing-share renewal flow** — guardian extends `shareExpiresAt` by 1 year:
  - **Backend**:
    - `shareInviteRepository.{getStandingShareById, listStandingSharesForGuardian, extendStandingShare}` — three new methods. List joins back to the parent invite so the UI has student/scope context in one round-trip.
    - `studentShareInviteService.renewStandingShare(standingShareId, userId)` — verifies the user matches the parent invite's `guardianUserId` (only the original consenting party can renew), refuses on revoked shares, sets `shareExpiresAt = now + 1 year` (NOT `existing + 1 year` — sequential renewals must not compound). Logs `update` activity event with `details.renewal=true`, previous + new expiry, and the parent inviteId. Constant `STANDING_SHARE_RENEWAL_MS = 365 days`.
    - Two new endpoints: `GET /api/shares/standing-shares/inbox` (guardian's standing shares with parent-invite payload) and `POST /api/shares/standing-shares/:id/renew`. Wired in `routes.ts`.
  - **Frontend**:
    - `useStandingSharesInbox()` and `useRenewStandingShare()` in `useSharesApi.tsx`; `StandingShareWithInvite` type exported.
    - `SharesPanel` Inbox tab now has two sections: "Pending invites" (the existing `GuardianInboxList`) and "Active standing shares" (new `StandingSharesList`). Each standing-share card shows scope (object types), expiry date, and a status badge. The Renew button only surfaces when the share is within `RENEW_THRESHOLD_DAYS=90` of expiry (or already expired).
    - Sorted with most-urgent first (soonest expiry / expired at top). Filters out revoked rows.
  - **i18n**: 6 new keys (`actions.renew`, `inbox.{pendingHeader,standingHeader}`, `empty.standing`, `standing.{expired,expiresInDays,expiresOn,renewedToast}`) added to all 11 locale files. Validator: 0 errors. Non-English files use English placeholders matching the existing pattern.
  - **No migration**: reuses the existing `update` event type with `details.renewal=true` rather than introducing a `standing_share_renewed` enum value. Audit queries can filter on `eventType='update' AND subjectType1='standing_share' AND details->>'renewal'='true'`. A dedicated event type can be added later if the rollup view warrants it.

- **Inbox deep-link** — `?tab=` query param + bell wiring:
  - `SharesPanel` reads the active tab from `useSearch()` (wouter): `?tab=outgoing|incoming|inbox`. Falls back to Outgoing when missing/invalid. A `useEffect` keyed on `search` re-syncs when the URL changes after mount, so clicks while already on `/shares` still switch the tab.
  - `ShareInboxBell` now navigates to `/shares?tab=inbox` via wouter's `setLocation` (was `setActiveFeature('shares')`). The pathname change triggers `FeaturePanelContext`'s existing location effect (which opens the panel and syncs `activeFeature`), so dropping the explicit `setActiveFeature` call is intentional — the URL is the source of truth.

- **Read-access logging — share-derived `view` activity events**:
  - New helper `server/services/sharing/audit.ts` exporting `recordShareDerivedView(ctx, subjectType, rows)` and `recordShareDerivedViewSingle(ctx, subjectType, row)`. Fire-and-forget; emits a `view` activity log entry per row whose `instituteId !== ctx.instituteId` (i.e., visible only via share). Student/admin principals don't trigger entries (student is the subject; admin reads tracked separately).
  - Each entry: `eventType='view'`, `subjectType1=<type>`, `subjectId1=<row.id>`, `subjectType2='student'`, `subjectId2=<row.studentId>`, `details={ ownerInstituteId, viaShare: true }`. The viewing institute is the entry's `instituteId`; the owner is in `details`.
  - Wired in:
    - `programRepository.{getProgramById, getProgramsByStudentId, getCurrentProgram}` — after the gated query returns.
    - `reportRepository` — `getMedicalRecordById/getMedicalRecordsByStudentId/getCurrentMedicalRecord/getArchivedMedicalRecords` and the parallel functional + educational variants (12 methods total).
    - `deepAnalysisService.{getDeepAnalysis, listDeepAnalysesForStudent}` — list projection extended with `studentId` + `instituteId` so the audit helper has what it needs.
    - AI memory-schema reads that bypass repos: `progress-memory-schema.ts programOps.read`, `analysis-memory-schema.ts list/get`, `reports-memory-schema.ts get/archived ops` for all three record types, and `chat-context-integration.ts loadMedicalRecord/loadFunctionalReport/loadEducationalReport`.
  - **Coverage gap**: `incident`, `monitor_note`, and `custom_app_assignment` aren't yet in the `activity_subject_type` enum, so their views aren't logged. Adding them is a one-line schema change + migration; deferred since the enum extension is independent of this lift and incidents currently aren't audit-logged at all (not even on create). The audit helper will accept those types as soon as the enum is extended.
  - Per-child reads (goals/objectives/data points/etc.) are not separately logged — the parent program's `view` event covers any traversal of its children, matching the root-only-ownership model.

- **Cross-institute write path lift — `permission='write'` shares now allow writes**:
  - `canAccessObject` extended with optional `requirePermission: 'read' | 'write'` — when `'write'`, only shares with `permission='write'` are counted (ownership and admin/student principals still pass).
  - New convenience export `canWriteObject(ctx, type, id, studentId, ownerInstituteId)` — equivalent to passing `'write'`.
  - `reportController.requireOwningInstitute` now consults `canWriteObject` (signature gained `objectType: ShareableObjectType`); 12 call sites updated to pass `'medical_record'` / `'functional_report'` / `'educational_report'`.
  - `programController` write paths (`updateProgram`, `activateProgram`, `archiveProgram`, `deleteProgram`) consult `canWriteObject(ctx, 'program', ...)` instead of the blanket `instituteId` mismatch check.
  - AI memory-schema `rejectCrossInstituteWrite` helpers (in `incident-memory-schema.ts` and `reports-memory-schema.ts`) now async, take the full record, and call `canWriteObject`. Progress-memory-schema's inline check upgraded the same way.
  - Net effect: a guardian (or any source admin) granting a `permission='write'` share to a target institute now actually allows that institute to write through both the controllers and the AI tool surface. Read-only shares still permit reads but reject writes — same as before.

- **AI access — memory schemas gated through the visibility helper**:
  - New boundary helper `server/services/sharing/sessionCtx.ts` exporting `buildSessionAccessCtx({ userId, studentId, instituteId, isAACFeature, isSystemAdmin })` — mirrors `buildClinicianCtx` but for the chat session. AAC → student principal; system admin → admin; family-institute escalation when applicable; otherwise institute principal.
  - `ChatContext.accessCtx` added; threaded through `createChatContextManager` → `ChatContextManager.baseContext.accessCtx` so every `DBOperationContext.all.accessCtx` carries it.
  - `sessionService.getMessageManager` now builds the `accessCtx` once per session and passes it in.
  - Per-schema gating:
    - `incident-memory-schema.ts` — list/get forward `accessCtx` to `incidentRepository.{listByStudent,getById}` (already ctx-aware). `add` attributes the new incident to the institute principal's selected institute (else null). `update`/`delete` re-fetch via the gate, then apply cross-institute write rejection.
    - `reports-memory-schema.ts` — current and archived reads on medical/functional/educational gated through `withInstituteVisibility`. Write ops on each type re-fetch via the gate and apply cross-institute write rejection (mirrors `requireOwningInstitute` in `reportController`). Parent `Context_Reports.read` threads `accessCtx` through to all three loaders.
    - `analysis-memory-schema.ts` — list/get gated through `withInstituteVisibility(deepAnalyses, ctx, 'deep_analysis')`. Read-only by design.
    - `progress-memory-schema.ts` — `programOps.read` gated through `withInstituteVisibility(programs, ctx, 'program')`. Children of programs inherit (root-only ownership). `programOps.write` rejects cross-institute updates and forces `instituteId = ctx.instituteId` on creates by institute principals.
    - `chat-context-integration.ts` — `loadMedicalRecord`/`loadFunctionalReport`/`loadEducationalReport` (used by parent `Context_Reports.read` and initial population) gated through `withInstituteVisibility` when `accessCtx` is set; legacy `instituteId`-only filter preserved as fallback.
  - `aac-memory-schema.ts` and `student-custom-apps-schema.ts` deliberately untouched — AAC mode is the student principal by definition, and custom-app reads route through the already-ctx-aware `customAppRepository`.
  - All type-clean (no new errors in touched files).

### Next session

The cross-institute sharing initiative as planned is **complete**. Remaining items are minor follow-ups:

- **Re-translate the gap keys** in he/ko/yue/zh/ru where the i18n reconciliation fell back to English placeholders. (1–13 keys per locale, mostly in landing-page sections added by parallel work.)
- **Read-access logging for unshared institute reads** — currently `recordShareDerivedView` only fires for cross-institute reads (rows where `instituteId !== ctx.instituteId`). HIPAA reviewers may also want logs for owning-institute reads of sensitive subjects (medical, behavioral). The audit helper already takes the rows; toggling on owned-row logging is a one-line change with a config flag.

# Subject-scoped chat sessions

## Goal

Prevent cross-subject data leakage in the clinician chat by making every chat session owned by a specific *(user, student, institute, instituteUser)* tuple, and forcing a new session whenever the subject *changes from one concrete value to another* on the next message. No separate "selection" endpoint is needed — the switch is detected at message time.

**Null → set is not a switch, set → different-set is.** Going from no student selected to a selected student (or null institute → an institute) updates the existing session in place. Only a transition between two different non-null values triggers a reset.

Covers clinician chat only (`server/services/sessionService.ts`). The AAC dual-agent session is **not in scope** — see "AAC dual-agent: not affected" below.

## Scope

- Schema change: `chatSessions` gains `instituteId` and `instituteUserId`.
- Session-lookup hardening: caller identity must match the session, else the session is rejected and a new one is opened.
- Subject-switch behavior: when the incoming *(studentId, instituteId)* disagrees with the session's stored values, start a fresh session seeded with the user's current message as its first entry. The AI does not see the prior conversation.
- Keep the generic chat layer unaware of CliniAACian specifics — all subject-matching logic lives where we already look up `context.student` / `context.institute`, not inside `ChatMessageManager`.

Out of scope:
- No `req.session.selectedInstituteId` / server-side selection store. Selection stays client-side; the server only validates *consistency between message, session, and caller*.
- Other security issues surfaced in the audit (deep-analysis access checks, license-permission gating, raw-studentId endpoints) are tracked separately.

## Schema change

File: `shared/schema-private.ts` (`chatSessions` table)

Add two nullable FKs alongside `userId` / `studentId` / `userStudentId`:

```ts
instituteId: varchar("institute_id").references(() => institutes.id),
instituteUserId: varchar("institute_user_id").references(() => instituteUsers.id),
```

Index: `idx_chat_sessions_institute_id` on `instituteId` (mirrors the existing student/user indexes).

Migration: `npm run db:generate` → `npm run db:migrate`. Both columns are nullable; existing rows remain untouched. Do NOT use `drizzle-kit push`.

## Server logic changes

### 1. `getMessageManager` (`server/services/sessionService.ts:994`)

Current behavior:
- Loads `context.student` / `context.institute` from the *request's* IDs.
- If `sessionId` is provided, calls `getSession(sessionId)` with no ownership or subject check.
- Reuses the session's `log` / `state` regardless of whether the request's subject matches.

New behavior (in this order, before line 1068's `if (sessionId)` block):

1. Resolve the incoming `studentId`, `instituteId`, `userId` into `context.student`, `context.institute`, `context.user`, `context.userStudent` (as today). Additionally resolve `context.instituteUser` from `(userId, instituteId)` via `instituteRepository.getMembership` (add the method if it doesn't exist).
2. If `sessionId` is provided, load the session row. For each of `studentId`, `instituteId`, `instituteUserId`, compare session value vs request value and classify:
   - `session === null && request === null` → neither matters, skip.
   - `session === null && request !== null` → **fill-in**: update the session row in place to set that field. No reset. (Covers "no student selected → student selected" and the analogous institute case.)
   - `session !== null && request === null` → **fill-in reversed**: ignore the null in the request and keep the session's value. (User deselected; we preserve context rather than silently drop it. The session still belongs to that subject.)
   - `session === request` → reuse.
   - `session !== null && request !== null && session !== request` → **switch**: reset session.

   Plus the ownership check:
   - **Reject (treat as no session):** `session.userId !== userId`. Log a warning — this is either a bug or an attempt to hijack another user's session. Open a fresh session.

   Any field that classified as **switch** triggers a reset of the whole session. Any fields that classified as **fill-in** are written back to the existing row in place. A request can contain both kinds simultaneously — if any field is a switch, the whole session resets (and the new session is created with the request's current values).

3. When creating a new session (either "no sessionId" or "reset"), populate `userId`, `studentId`, `userStudentId`, `instituteId`, `instituteUserId` on the insert.
4. When resetting because of a subject switch, **do not copy `log` or `state` into the new session**. The user's current message becomes the first turn. Return the new session's ID to the caller so the client updates its stored ID (this already works — controllers forward `data.sessionId` back; see `useChat.tsx:764`).
5. Fill-in writes use `updateSession(sessionId, { studentId, instituteId, instituteUserId, userStudentId })` for whichever fields transitioned from null → value. No history is affected.

Encapsulate this in a small helper inside `sessionService.ts`, e.g.:

```ts
type SessionResolution =
  | { kind: "reuse"; session: ChatSession }
  | { kind: "reset"; reason: "subject_switch" | "ownership_mismatch" };

function resolveSession(
  existing: ChatSession | undefined,
  identity: { userId?: string; studentId?: string; instituteId?: string; instituteUserId?: string }
): SessionResolution;
```

This keeps the decision out of the generic chat layer. `getMessageManager` orchestrates; `ChatMessageManager` is unchanged.

### 2. `getSession` (`server/services/sessionService.ts:765`)

Leaves the raw query intact (some callers need the row regardless). The ownership/subject check moves into `getMessageManager`. Add a JSDoc warning that `getSession` is not access-controlled and that callers must check identity.

### 3. `createSession` call sites

Both call sites inside `getMessageManager` (`sessionService.ts:1078`) need the two new fields. Any other `createSession` caller found via `Grep("createSession", "server")` gets the same treatment. If a caller doesn't have an instituteId, pass `null` — nullable columns are intentional for backwards compat with flows that don't have institute context.

### 4. AAC dual-agent: not affected

The AAC session has no institute of its own. It is scoped to a single student and has read-only access to the basic institute information for every institute that student belongs to (events, etc. — the exact surface will be refined separately). Because the session is student-only, the only subject that can change is the student, and that is already handled by the dual-agent service creating a new session when `studentId` changes.

No schema or code change to the dual-agent path in this plan.

### 5. Return value

`onMessageStreaming` and `onMessageMdStreaming` already return `sessionId` in the response payload. No contract change needed — but we should ensure that when we open a fresh session due to a subject switch, the response carries the *new* ID so the client immediately starts using it. This is already the case (see `useChat.tsx:764–795` and `sessionService.ts` — each response carries `data.sessionId`).

## Client changes

### Clinician (`client/src/hooks/useChat.tsx`)

Already sends `instituteId` on every message (line 713). No request-shape change required. The client's local `session.id` will be replaced automatically by whatever the server returns in the response (`useChat.tsx:764`). That handles the "new session on switch" flow without extra code.

**Optional UX polish (not required for security):** when `useStudent`/`useInstitute` changes, the client could proactively clear its cached `session.id` so the first message after the switch doesn't even try to reuse it. The server would reject it anyway, but preempting the round-trip avoids a wasted check. This is a small edit in `useChat.tsx`'s `useEffect` that watches `student?.id` and `currentInstitute?.id`.

### AAC client

No changes. The AAC session is student-only; institute context is read-only and sourced via the student's memberships.

## Edge cases

- **Concurrent messages during switch.** User sends message M1 for student A, immediately switches to student B and sends M2 before M1's response returns. M1's request carries `sessionId: S_A, studentId: A` — server reuses `S_A`, responds normally, writes to A. M2's request carries `sessionId: S_A, studentId: B` — server detects mismatch, opens fresh `S_B` with M2 as first turn, returns `S_B`. Client's session state races between the two responses; whichever arrives last wins. That's acceptable because both responses are individually correct — M1's result lands on A, M2's on B — and the client's `persistSession` localStorage write is idempotent per the last response's `sessionId`.
- **Subject switch with no message in between.** The user switches student in the UI without sending a message. Server does nothing. The next message opens a new session (if switching between two concrete students) or fills in the session (if the session had no student). Matches the user's stated requirement exactly.
- **"No student selected" → "student selected"** without a message in between. First message with the new student **updates the existing session** in place — `session.studentId` is written from null to the new studentId, history is preserved. Same for `null → institute`. (If the prior message *had* been sent with a concrete studentId, then selecting a *different* student and sending the next message would be a switch → reset. Only null → value is a fill-in.)
- **"Student selected" → "no student selected"** with the client sending `studentId: null` on the next message. We keep the session's stored studentId and ignore the null. The session is still about that student. If the client wants to truly start over, it should open a new session by clearing its stored `sessionId`.
- **Institute switch while student stays the same.** Counts as a subject switch (`instituteId` changed from one value to another → reset). Correct — different institute may have different license permissions, memory scope, etc.
- **Null-institute session + request with instituteId.** Fill-in: the session's `instituteId` is updated in place. No reset.
- **AI-driven `selectStudent` tool call** (`server/services/chat/tool-router.ts:303`). Fires an SSE event to the client; the client updates its state; the user's *next* message will carry the new `studentId` and trigger the reset. No special server-side handling needed — the same message-time detection applies.
- **Session hijack attempt** (someone else's `sessionId` with matching student): caught by the `userId` check in step 2 of `getMessageManager`. Log and open a new session instead of failing loud (fail-loud would leak the existence of session IDs).
- **Legacy rows without `instituteId`.** Pre-migration sessions have `instituteId: null`. A request with an instituteId hits the **fill-in** branch and the session is updated in place — no history loss. Clean migration story.

## Testing

- Unit: session-resolution helper — cover reuse, switch (A→B for each of studentId / instituteId / instituteUserId), fill-in (null→A for each field), reversed fill-in (session has A, request has null → keep A), ownership-mismatch, and legacy-null-institute.
- Integration: POST `/api/chat` with `studentId: null`, then POST again with `studentId: A` reusing the same `sessionId`; assert second response returns the *same* `sessionId` and the session now has `studentId = A` with full prior history intact.
- Integration: POST `/api/chat` twice with different `studentId`s (A then B) sharing a `sessionId`; assert second response returns a *new* `sessionId` and its log contains only the second message.
- Integration: POST `/api/chat` with someone else's `sessionId`; assert a new session is opened and no data from the other user's session leaks into the response.
- Manual smoke: switch student in the clinician UI mid-conversation, verify the AI doesn't reference prior student's context.

## Rollout

Two commits:
1. Schema + migration + nullable wiring in `createSession` call sites. No behavior change.
2. Subject-switch detection + rejection logic + dual-agent parameter threading + client `initialize` field.

Split keeps the migration separate from the behavior change so a rollback of the logic doesn't force a schema rollback.

## Files touched (anticipated)

- `shared/schema-private.ts` — `chatSessions` table + index
- New Drizzle migration under `drizzle/`
- `server/services/sessionService.ts` — `getMessageManager`, `createSession` calls, new resolution helper
- `server/repositories/instituteRepository.ts` — add `getMembership(userId, instituteId)` if absent
- `client/src/hooks/useChat.tsx` — optional preemptive session clear on student/institute change (not required for correctness)

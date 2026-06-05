# Clinician Client — Chat, Memory, and Real-Time Refresh

This document describes how the **clinician platform** (the `client/` app, used by
caregivers, therapists, and teachers — *not* the `client-aac/` student app) works
end to end: the chat-driven interface, how the server's memory system backs it, and
how an AI memory mutation propagates back to the live UI in real time.

For the high-level platform picture see [`SYSTEM_OVERVIEW.md`](./SYSTEM_OVERVIEW.md);
for the AAC student client see [`ai-docs/main.md`](../ai-docs/main.md).

---

## 1. Design principle: the chat *is* the interface

Almost every clinician operation — creating a student, editing a goal, authoring an
AAC board, scheduling a calendar event, updating AAC settings, generating a game — is
reachable through a single natural-language chat. The feature panels (StudentsPanel,
ReportsPanel, CalendarPanel, board editor, etc.) are **views over data the chat agent
reads and writes**, not independent CRUD surfaces. Only a small set of high-security
operations are gated behind explicit UI.

This produces the central design constraint of the client: **when the AI changes data
through chat, the panels showing that data must update without a manual reload.** The
mechanism that achieves this is the `contextData` channel (§5).

---

## 2. Client architecture

### 2.1 `ChatProvider` / `useChat` — `client/src/hooks/useChat.tsx`

`ChatProvider` is the single source of truth for a chat conversation. It owns:

- `session` / `sessionId` — the current `ChatSession` (persisted server-side).
- `history` — the `ChatMessage[]` rendered in the transcript.
- `mode` — the active feature (`activeFeature` from `FeaturePanelContext`), sent as
  `activeFeature` on every request so the server can load feature-specific tools and
  context.
- `persona` — the selected persona UUID (see §6).
- `thinkingText` / `isThinking` — live status shown while the AI runs tool calls.
- `aiRefreshing` — a `Set<string>` of panel keys currently being refreshed by an AI
  action; panels read this to show a loading shimmer.
- File-attachment state (`pendingFiles`, `contextFiles`, `attachedFiles`).

All network calls go through `apiRequest` / `fetch` against the shared backend.
`sendMessage(content, options)` is the core action; convenience wrappers
`sendBoardPrompt` and `sendInterpretRequest` set a different `replyType`.

### 2.2 Streaming transport — `client/src/hooks/useChatStream.ts`

`useChat` does not POST directly for the common path. It calls
`useChatStream().sendStreamingMessage(body, callbacks)`, which opens an
**SSE stream** against `POST /api/chat/stream` using `fetch` + `ReadableStream`.

`parseSSEEvents()` is a stateful parser: because CloudFront / TCP can split an
`event:`/`data:` pair across chunk boundaries, it carries `SSEParserState`
(`currentEvent`, `currentData`) between reads so a partial event is completed on the
next chunk rather than dropped.

The server emits these SSE event types, each dispatched to a callback:

| SSE event       | Callback           | Effect in `useChat`                                              |
|-----------------|--------------------|-----------------------------------------------------------------|
| `thinking`      | `onThinking`       | Sets `isThinking` + `thinkingText`; clears any md preamble.      |
| `text_delta`    | `onTextDelta`      | Appends a token to a streaming placeholder message (md mode).    |
| `navigate`      | `onNavigate`       | `setActiveFeature(feature)` — AI switches panels.                |
| `select_student`| `onSelectStudent`  | `selectStudent(studentId)` — AI switches subject.               |
| `file_extracted`| `onFileExtracted`  | Caches server-extracted text on the file (avoids re-uploading). |
| `files_needed`  | `onFilesNeeded`    | Re-uploads expired media to `/api/chat/files/upload`.           |
| `complete`      | `onComplete`       | Final payload → `processResponseData(data)` (§5).               |
| `error`/`close` | —                  | Ends the stream; may trigger fallback.                          |

### 2.3 Streaming → fallback resilience

`sendMessage` is built to survive Lambda cold starts. If the stream fails to
*complete* (and the user didn't explicitly stop, and no md content already arrived),
it falls back to the non-streaming `POST /api/chat` endpoint, retrying only on
`ServiceUnavailableError` (502/503/504) with gentle backoff inside a ~25 s budget so a
normal cold start resolves invisibly. Real errors surface immediately. Both paths
funnel their final JSON through the same `processResponseData()` helper, so the
`contextData` handling in §5 is identical regardless of transport.

### 2.4 Message lifecycle inside `sendMessage`

1. Build a `ChatMessage` (role `user`) and **optimistically** append it to `history`.
2. Move `pendingFiles` → `contextFiles` (they're now associated with a sent message).
3. Assemble the request body: `messages`, `replyType` (`md` default), `activeFeature`,
   `persona`, `timezone`, plus `sessionId` / `userId` / `studentId` / `instituteId`
   when known, plus `featureContext` for `boards` mode and any attached `documents`.
4. Stream; on `text_delta`, maintain a single placeholder message flagged
   `metadata.isStreaming` that is replaced token-by-token, then removed and swapped for
   the authoritative `complete` message.
5. `onComplete` → `processResponseData(data)` which appends the assistant message,
   updates/creates the `session`, caches file extractions, and — critically — calls
   `handleContextData(data.contextData)`.

---

## 3. Server request path (orientation)

The full server architecture lives in the server services; the client only needs to
know the shape. Endpoints are registered in `server/routes.ts`:

- `POST /api/chat` → `chatController.onMessage` (non-streaming).
- `POST /api/chat/stream` → `chatStreamController.onMessage` (SSE).
- `GET /api/chat/sessions/:id` → load a persisted session.
- `POST /api/chat/files/upload` → temporary server-side file cache.
- `GET /api/personas/selectable` → selectable personas (§6).

All run under `optionalAuth`. The controllers delegate to **`sessionService`**, whose
three entry points mirror the transports:

- `onMessage()` — non-streaming, returns the full JSON in one response.
- `onMessageStreaming()` — HTML streaming with thinking updates.
- `onMessageMdStreaming()` — an `AsyncGenerator` yielding `text_delta` / `thinking` /
  `navigate` / `complete` events token-by-token (the path the clinician client uses).

`sessionService.getMessageManager()` assembles a **`ChatMessageManager`**
(`server/services/chat/chat-handler.ts`) that owns the LLM loop: it builds the prompt
and tool set (`prompt-kit.ts`), selects a provider (`providers/`), and routes tool
calls (`tool-router.ts`). Memory tools are bridged to the database by
`memory-db-bridge.ts` (§4).

---

## 4. The memory system

The clinician AI does not call bespoke CRUD endpoints. Instead it operates a
**structured memory tree**, and the server maps reads/writes on that tree to real
database tables and JSONB columns. This indirection is what lets one chat agent touch
every part of the platform.

### 4.1 Memory fields — `server/services/memory-schema/*.ts`

Each file exports **memory field definitions** (`AgentMemoryFieldWithDB` and its
array/object variants from `chat/memory-types.ts`). A field declares:

- shape — `string` / `object` / `array` / `map` / topic-tree, with nested `properties`
  or `items`;
- display metadata — `id`, `title`, `description`, `opened`;
- a `db` block of `MemoryDBOperations`: `read`, `write`, and (for collections)
  `add` / `delete` / `clear`, each receiving a `DBOperationContext`.

Fields are grouped by domain and prefixed by convention:

| Prefix       | Source file(s)                          | Backing store                                  |
|--------------|-----------------------------------------|------------------------------------------------|
| `User_`      | `user-memory-schema.ts`                 | `users.chatMemory` JSONB                       |
| `Student_`   | `student-memory-schema.ts`              | `students.chatMemory` JSONB (mostly)           |
| `Relationship_` | `relationship-memory-schema.ts`      | `userStudents.chatMemory` JSONB                |
| `Student_Contacts` | `contacts-memory-schema.ts`       | `studentContacts` **table**                    |
| `Student_Incidents` | `incident-memory-schema.ts`      | `incidents` **table**                          |
| `Context_*`  | various                                 | session-scoped, **not persisted** (see §5)     |

These compose into the master field list registered in `sessionService`, and a
filtered subset is used for AAC mode via `getAACMemoryFields()` in
`aac-memory-schema.ts`.

A representative field — `STUDENT_PEOPLE_FIELD` in `student-memory-schema.ts`:

```ts
export const STUDENT_PEOPLE_FIELD: AgentMemoryFieldArrayWithDB = {
  id: "Student_People",
  type: "array",
  items: { id: "Person", type: "object", properties: { Name: {…}, Relationship: {…} } },
  db: {
    read:   (ctx) => getStudentMemoryField(ctx, "Student_People"),
    write:  (ctx, v) => setStudentMemoryField(ctx, "Student_People", v),   // no-op
    add:    (ctx, v) => addToStudentMemoryArray(ctx, "Student_People", v), // no-op
    delete: (ctx, k) => deleteFromStudentMemoryArray(ctx, "Student_People", k), // no-op
    clear:  (ctx)   => clearStudentMemoryArray(ctx, "Student_People"),     // no-op
  },
};
```

### 4.2 Read on load, write as one atomic batch

A deliberate asymmetry in the `db` operations is key to understanding persistence:

- **`read`** genuinely hits the DB. `getMessageManager()` pre-loads every *visible*
  field through `memory-db-bridge.populateMemoryFromDB()`, producing a flat
  `memoryValues` map (`{ "Student_People": […], "Student_Interests": […] }`) the LLM
  sees in its prompt.
- **`write` / `add` / `delete` / `clear` are no-ops** for `chatMemory`-backed fields.
  The AI's tool calls mutate an **in-memory** copy synchronously inside the
  `ChatMessageManager` (eliminating races between parallel tool calls), and the final
  state is persisted **once** by `onUpdateMemoryValues` in `sessionService`, which
  writes `students.chatMemory` (or the relevant column) in a single atomic update.

Table-backed fields (`Student_Contacts`, `Student_Incidents`) and column-backed fields
(`Student_CommunicationProfile`, routed to `students.communication_profile`) have real
write paths instead, because they don't live in the JSONB blob.

### 4.3 Access control at the schema layer

Reads fail closed. `getStudentMemoryField()` refuses to return data unless the request
carries a resolved `accessCtx` (`AccessCtx` from `sharing/visibility.ts`), and a
`student`-kind principal may only read its own bound `studentId`. This is
defense-in-depth: even if a caller smuggles a `studentId` into the request body, the
chatMemory (notes, people, etc.) is not dumped without a valid principal. The
`monitor_note` share type governs whether a clinician AI in one institute can see the
AAC monitor's `chatMemory` notes for a shared student at all — ungranted fields are
filtered out of the schema entirely so the AI doesn't know they exist.

---

## 5. Real-time refresh: how a memory write reaches the UI

This is the mechanism that keeps panels live. The server never pushes a panel reload
directly; instead it tells the client *what changed*, and the client invalidates the
matching React Query caches.

### 5.1 Server: `extractContextFromMemoryValues()` — `sessionService.ts`

After the LLM turn completes, `sessionService` computes a `contextData` object from the
final `memoryValues` and includes it in both the non-streaming response and the SSE
`complete` event. Two rules:

1. **`Context_*` fields become direct data payloads.** Every key prefixed with
   `Context_` is stripped and lowercased: `Context_Board → board`,
   `Context_AACSettings → aacsettings`, `Context_CustomApp → customapp`,
   `Context_Reports → reports`, `Context_Calendar → calendar`,
   `Context_Institutes → institutes`. These carry the *actual* fresh data so the panel
   can render without a round-trip. `Context_*` fields are session-scoped and never
   persisted — they exist only to ferry the working object to the client.

2. **Touched `Student_*` fields become invalidation signals.** When a real
   student-scoped field was written, the server emits a scoped signal instead of the
   data:

   ```ts
   if (opts.studentId) {
     if ("Student_Contacts" in memoryValues)
       contextData.studentContactsUpdated = { studentId };
     const touched = Object.keys(memoryValues).filter(
       k => k.startsWith("Student_") && !IGNORED_FOR_STUDENT_UPDATE.has(k));
     if (touched.length) contextData.studentUpdated = { studentId };
   }
   ```

So a write to `students.chatMemory` surfaces to the client as
`studentUpdated: { studentId }`, and a contacts-table write surfaces as
`studentContactsUpdated: { studentId }`. Other domains (programs, institutes,
calendar, reports) emit their own `*Updated` signals through the same response shape.

### 5.2 Client: `handleContextData()` — `useChat.tsx`

`processResponseData()` calls `handleContextData(contextData)`, a single dispatcher
that translates each key into a concrete client action. Three categories:

**(a) Direct store/state updates — no refetch needed.** When the payload already
contains the data, write it straight into the relevant Zustand store so the panel
updates even if it isn't mounted:

- `contextData.board` → `useBoardStore.getState().updateBoard()` (or `setBoard()`),
  plus `setSharedState` for the legacy board selector.
- `contextData.customapp` → `useCustomAppStore.getState().setDefinition(..., { markDirty })`.
- `contextData.interpret` → `setSharedState({ interpretData })`.

**(b) Navigation / context switches.**

- `setPersona` → validated against loaded personas, then `setPersonaState`.
- `navigateToFeature` → `setActiveFeature`.
- `selectStudentId` / `selectInstituteId` → `selectStudent` / `selectInstitute`.

**(c) Cache invalidation — the live-refresh path.** For `*Updated` signals,
`handleContextData` marks the affected panel(s) in `aiRefreshing` and invalidates the
matching React Query keys, which makes any mounted panel refetch:

| `contextData` key            | Action                                                                 |
|------------------------------|------------------------------------------------------------------------|
| `studentUpdated` / `students` / `studentsUpdated` | invalidate `/api/students` (+ the student's details, programs, links); dispatch `cliniaacian:students-updated` for `StudentProvider` (which holds its list in `useState`, not query cache). |
| `studentContactsUpdated`     | invalidate biometric contacts + linkable-entities + program team cards. |
| `institutes*` / `instituteUpdated` | invalidate `/api/institutes` (+ members, classrooms, students, pending invites). |
| `classroomsUpdated` / `instituteStudentsUpdated` | invalidate that institute's classroom / students tabs. |
| `program` / `programUpdated` | invalidate the program, its goals, and the student's program lists.    |
| `reports` / `reportsUpdated` | invalidate `/api/students/:id/reports`.                                |
| `calendar` / `calendarUpdated` | invalidate `/api/calendar/events`.                                   |
| `aacsettings` / `aacprompt` / `aacautoprompt` | invalidate the student record (AAC settings panel reads it). |

After dispatch, a `setTimeout(…, 2000)` clears `aiRefreshing` so the loading
indicators resolve once the refetches land.

### 5.3 Why two strategies (data vs. signal)

`Context_*` direct-data is used where the chat agent *is* the editor of a working
document (a board, a game, AAC settings) and the panel should reflect the in-flight
object immediately — including when the panel isn't even mounted, since the data is
written into a global store. Invalidation signals are used for normalized records that
already have authoritative query endpoints (students, contacts, programs, calendar);
re-querying is cheaper and safer than trying to serialize the full record back through
chat. The result is the same from the user's perspective: edit something by talking to
the AI, and the relevant panel updates within the same turn.

---

## 6. Personas and prompt assembly

Selectable personas are fetched from `GET /api/personas/selectable` (cached 5 min,
gated on auth) and exposed through `useChatPersona`. A `PersonaInfo` carries an `icon`,
`title`/`description` (plain or multilingual JSON), a persona-specific `prompt`, and
`manualSelection` / `active` / `testMode` flags. The selected persona UUID is sent as
`persona` on each request; the server composes the final system prompt from a base
prompt plus the persona's `prompt`, resolving jurisdiction placeholders
(`{{US_ONLY:…}}` / `{{IL_ONLY:…}}`) against the active compliance framework. The AI can
also switch persona mid-conversation via `contextData.setPersona`, which the client
validates before applying.

---

## 7. Sessions and persistence

A conversation is a `chat_sessions` row (`shared/schema-private.ts`). The fields the
client touches:

- `log` — the full, untrimmed `ChatMessage[]` (used for replay and deep analysis).
- `state` — `ChatState`: culled `history`, `conversationSummary`, `openedTopics`, and
  `memoryState` (which memory paths are visible/opened/paginated).
- `last` — the last few messages, for quick recap.

The client persists only the `sessionId` (in `localStorage`, keyed by
user + student + feature when `persistSession` is on) and rehydrates via
`loadSession()` → `GET /api/chat/sessions/:id`. Switching the selected student clears
the session (`useEffect` on `student?.id` → `clearSession`), since a conversation is
scoped to one subject. The server enforces the same boundary: a session's
`userId`/`studentId`/`instituteId` can be filled in when null but not switched
mid-session.

---

## 8. End-to-end example

A clinician types *"add Maya's grandmother Rivka as a contact and note that she
loves horses."*

1. `sendMessage` POSTs to `/api/chat/stream` with `studentId`, `activeFeature`,
   `persona`.
2. `sessionService` builds the `ChatMessageManager`, pre-loading visible `Student_*`
   fields from `students.chatMemory` and `studentContacts`.
3. The LLM streams `thinking` events while it calls memory tools: one `add` on
   `Student_Contacts` (real table write) and one `add` on `Student_Interests`
   (in-memory, batch-persisted by `onUpdateMemoryValues`).
4. On completion, `extractContextFromMemoryValues` emits
   `{ studentContactsUpdated: { studentId }, studentUpdated: { studentId } }`.
5. The SSE `complete` event reaches `onComplete → processResponseData →
   handleContextData`.
6. `handleContextData` marks `contacts` and `studentInfo` in `aiRefreshing` and
   invalidates the contacts, linkable-entities, and student queries.
7. The StudentContactsPanel and StudentInfoPanel — if mounted — refetch and show Rivka
   and the new interest, all within the same chat turn, with no manual reload.

---

## 9. Key files

| Concern                          | File                                                        |
|----------------------------------|-------------------------------------------------------------|
| Chat state, send loop, `handleContextData` | `client/src/hooks/useChat.tsx`                     |
| SSE transport + parser           | `client/src/hooks/useChatStream.ts`                         |
| Chat endpoints                   | `server/routes.ts`                                          |
| Chat controllers                 | `server/controllers/chatController.ts`, `chatStreamController.ts` |
| Orchestration + `contextData`    | `server/services/sessionService.ts`                         |
| LLM loop / tool calls            | `server/services/chat/chat-handler.ts`, `tool-router.ts`    |
| Prompt + tool assembly           | `server/services/chat/prompt-kit.ts`                        |
| Memory ↔ DB bridge               | `server/services/chat/memory-db-bridge.ts`                  |
| Memory field definitions         | `server/services/memory-schema/*.ts`                        |
| Personas                         | `server/controllers/personaController.ts`                   |
| Session table                    | `shared/schema-private.ts` (`chat_sessions`)                |

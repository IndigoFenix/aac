# Dual Agent System Analysis

## Overview

The dual agent system is an AAC (Augmentative and Alternative Communication) system that uses two AI agents:
1. **Interactive Agent** - Fast responses using `gpt-4o-mini`
2. **Monitor Agent** - Background processing using `gpt-4o` for memory/context management

## Complete Request Flow: `POST /api/aac/dual/message`

### Step 1: Route Handling
**File:** `server/routes.ts` (lines 860-862)

```typescript
app.post("/api/aac/dual/message", optionalAuth, requireOnboardingComplete, aacUpload.single("image"), (req, res) =>
  dualAgentController.message(req, res)
);
```

**Middleware chain:**
- `optionalAuth` - Authenticates user (optional)
- `requireOnboardingComplete` - Ensures user completed onboarding
- `aacUpload.single("image")` - Multer file upload (single image, up to 20MB)

---

### Step 2: Controller Processing
**File:** `server/controllers/dualAgentController.ts` (lines 119-219)

**What happens:**
1. Extract `userId` from authenticated request
2. Parse multipart form data:
   - `board` (JSON string → object)
   - `identifiedPerson` (JSON string → object)
   - Convert multer image file buffer to base64 data URL
3. Validate request with Zod schema:
   - `studentId` (required)
   - `sessionId` (optional)
   - `message` (optional)
   - `language` (optional)
   - `board` (optional)
   - `visualContext` (optional)
   - `audioContext` (optional)
   - `imageData` (optional)
   - `identifiedPerson` (optional)
   - `silentMode` (optional)
4. Set up SSE (Server-Sent Events) headers
5. Create `DualAgentInput` object
6. Call `dualAgentService.processInput(input)` and stream chunks back

---

### Step 3: Dual Agent Service Orchestration
**File:** `server/services/dual-agent/dual-agent-service.ts` (lines 418-496)

**Method:** `processInput(input)` - Async Generator

#### 3.1 Session Initialization
```typescript
const state = await this.initializeSession(
  input.studentId,
  input.userId,
  input.sessionId
);
```
- Checks in-memory cache first (30-minute TTL)
- If not cached, loads from database (`chatSessions` table)
- If new session, calls `createNewSession()`

#### 3.2 Audio Transcription (if voice input)
```typescript
if (input.audioBlob) {
  const transcription = await whisperService.transcribe(input.audioBlob, ...);
  userMessage = transcription.text;
  yield { type: "transcription", data: transcription };
}
```

#### 3.3 Pending Message Queuing
```typescript
const pendingMessage: PendingMessage = {
  role: "user",
  content: userMessage,
  timestamp: Date.now(),
  boardState: input.board,
  visualContext: input.visualContext,
  audioContext: input.audioContext,
};
state.pendingMessages.push(pendingMessage);
```

#### 3.4 Mode Selection
- **If `thinkingMode === true`:** Monitor Agent responds directly
- **If `thinkingMode === false`:** Interactive Agent responds, Monitor runs in background

---

### Step 4: Interactive Agent (Fast Response)
**File:** `server/services/dual-agent/interactive-agent.ts`

**Model:** `gpt-4o-mini`

**Process:**
1. Build message history from:
   - System prompt (created by Monitor during init)
   - Main message log from database
   - Pending messages (accumulated since last Monitor sync)
   - Current board context
   - Visual/audio/person context

2. Add vision if image provided:
   ```typescript
   content: [
     { type: "text", text: userMessage },
     { type: "image_url", image_url: { url: imageData, detail: "low" } }
   ]
   ```

3. Call OpenAI with tools:
   - **Tool:** `update_board` - Generate new board buttons
   - **max_tokens:** 500
   - **temperature:** 0.7
   - **tool_choice:** "required"

4. Stream response yielding:
   - `text` - Response text (progressive)
   - `board` - Updated communication board
   - `command` - Special commands starting with `#` (e.g., `#think`)

---

### Step 5: Monitor Agent (Background Processing)
**File:** `server/services/dual-agent/monitor-agent.ts`

**Model:** `gpt-4o`

**Triggered:** Asynchronously after Interactive responds

**Process:**
1. Process pending messages queue
2. Use `sessionService.onMessage()` to access memory/database tools
3. Search student context (`/Student_Notes`, `/Student_CommunicationPreferences`)
4. Update memory based on conversation
5. Return:
   - `updatedPrompt` - New system prompt for Interactive
   - `contextInjection` - Context to inject
   - `notes` - Notes to store in student memory

---

### Step 6: Session Persistence
**Database Table:** `chatSessions`

**Saved Fields:**
- `id`, `studentId`, `userId`, `chatMode: "aac"`
- `state: { history: [], conversationSummary: "", ... }`
- `log` (messages), `last` (last 2 messages)
- `pendingMessages`, `interactivePrompt`
- `thinkingMode`, `monitorBusy`, `status: "open"`

---

### Step 7: Client-Side Consumption
**File:** `client-aac/src/hooks/useDualAgent.ts`

**Hook:** `useDualAgent(options)`

**Process:**
1. Capture camera frame if available
2. Get identified person (biometric)
3. Build FormData/JSON payload
4. Call `/api/aac/dual/message` with streaming
5. Process SSE events:
   - Update `currentMessage` state
   - Play audio chunks
   - Update board via callback
   - Handle transcription display

---

## Data Flow Diagram

```
CLIENT REQUEST
    ↓
POST /api/aac/dual/message
    ↓
[Middleware: optionalAuth, requireOnboardingComplete, file upload]
    ↓
DualAgentController.message()
    ├─ Parse multipart form data
    ├─ Validate with Zod schema
    └─ Create DualAgentInput
         ↓
    DualAgentService.processInput()
         ├─ Initialize/Resume session (cache → DB)
         ├─ Transcribe audio (if voice input)
         ├─ Queue pending message
         │
         ├─ INTERACTIVE MODE (default):
         │   ├─ InteractiveAgent.processMessageStream()
         │   │   ├─ Build message history
         │   │   ├─ Add vision context (image)
         │   │   ├─ Call OpenAI gpt-4o-mini
         │   │   ├─ Stream: text, board, commands
         │   │   └─ Yield chunks to client
         │   │
         │   └─ Trigger Monitor Async (background):
         │       ├─ MonitorAgent.processPendingMessages()
         │       ├─ Call OpenAI gpt-4o
         │       ├─ Access memory/database tools
         │       ├─ Update Interactive prompt if needed
         │       └─ Mark Monitor complete
         │
         └─ THINKING MODE (if #think command):
             └─ MonitorAgent.respondInThinkingMode()
                 ├─ Call OpenAI gpt-4o (streaming)
                 ├─ Respond directly to user
                 └─ Check for #resume to exit thinking mode

    Save final session state to DB
         ↓
    SSE STREAM to CLIENT
    ├─ event: transcription
    ├─ event: text (progressive chunks)
    ├─ event: board
    ├─ event: audio (base64 chunks)
    └─ event: complete (sessionId)
         ↓
CLIENT useDualAgent Hook
    ├─ Parse SSE events
    ├─ Update currentMessage state
    ├─ Queue audio for playback
    ├─ Update board UI
    └─ Display final response
```

---

## Key Files

| File | Purpose |
|------|---------|
| `server/routes.ts` | Route registration |
| `server/controllers/dualAgentController.ts` | Request parsing, SSE setup |
| `server/services/dual-agent/dual-agent-service.ts` | Core orchestration, session management |
| `server/services/dual-agent/interactive-agent.ts` | Fast response generation (gpt-4o-mini) |
| `server/services/dual-agent/monitor-agent.ts` | Background processing, memory access (gpt-4o) |
| `server/services/dual-agent/types.ts` | Type definitions |
| `client-aac/src/hooks/useDualAgent.ts` | Client hook for API communication |
| `client-aac/src/contexts/DualAgentContext.tsx` | React context provider |

---

## Key Features

| Feature | Implementation |
|---------|----------------|
| Vision Input | Image data (base64) included in OpenAI message |
| Biometric Integration | `identifiedPerson` context injected into prompt |
| Silent Mode | Suppresses text/audio output, shows buttons only |
| Memory Context | Monitor searches `/Student_Notes` and preferences |
| Dual-Agent Architecture | Interactive (fast) + Monitor (thorough, async) |
| Session Caching | In-memory cache (30min TTL) + database persistence |
| Streaming Response | SSE for real-time text/audio/board updates |
| Board Generation | Interactive can call `update_board` tool |
| Thinking Mode | Monitor can take over for complex tasks |
| Audio Output | TTS synthesis via OpenAI API (base64 MP3 chunks) |

---

## Known Issues / Areas to Investigate

### Issue 1: Monitor Concurrency Control is NOT Properly Handled

**Location:** `dual-agent-service.ts` lines 563-567

```typescript
// Trigger Monitor processing if not busy (set flag immediately to prevent races)
if (!state.monitorBusy) {
  state.monitorBusy = true;
  this.triggerMonitorProcessing(state, monitorAgent, interactiveAgent, board);
}
```

**Problems:**

#### 1.1 Non-Atomic Check-and-Set (Race Condition)
The check `if (!state.monitorBusy)` and set `state.monitorBusy = true` are NOT atomic operations. In Node.js async context:

- Request A checks `state.monitorBusy` → false
- Request B checks `state.monitorBusy` → false (before A sets it)
- Request A sets `state.monitorBusy = true`
- Request B sets `state.monitorBusy = true`
- BOTH requests call `triggerMonitorProcessing()` → **TWO CONCURRENT MONITORS**

This can happen when messages are sent in rapid succession.

#### 1.2 In-Memory-Only Protection
The protection relies on the cached `state` object being shared. This works IF:
- Both requests hit the same cached session

But breaks IF:
- Session was evicted from cache (30min TTL)
- Two requests arrive simultaneously before cache is populated
- Server was restarted

When loading from DB (`loadSessionFromDB`, line 319):
```typescript
monitorBusy: session.monitorBusy || false,
```
Each load creates a NEW state object, so they don't share the in-memory flag.

#### 1.3 DB Flag Update is Async (Not Awaited)
```typescript
// Line 566 - NOT awaited
this.triggerMonitorProcessing(state, monitorAgent, interactiveAgent, board);
```

Inside `triggerMonitorProcessing` (line 680):
```typescript
await this.updateMonitorBusy(state.sessionId, true);
```

The DB update happens AFTER the function is called, not before control returns. A second request could check the DB before it's updated.

#### 1.4 No Crash Recovery
If server crashes while `monitorBusy = true`:
- DB flag stays `true` forever
- On restart, session loads with `monitorBusy = true`
- Monitor never runs again for that session
- No timeout/staleness check for the DB flag

#### 1.5 No Mutex/Lock Implementation
There's no actual mutex, semaphore, or lock. Just a boolean flag with check-then-act pattern.

**Impact:**
- Multiple concurrent Monitor agents can run for the same session
- Memory operations could conflict/duplicate
- Student context updates could be lost or corrupted
- Wasted API calls to GPT-4o

**Recommended Fix:**
Need a proper mutex implementation, e.g.:
- Database-level locking (SELECT FOR UPDATE)
- Redis-based distributed lock
- In-memory mutex with async-mutex library
- At minimum: atomic compare-and-swap with DB transaction


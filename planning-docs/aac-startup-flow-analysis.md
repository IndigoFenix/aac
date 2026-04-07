# AAC Startup Flow Analysis

## Overview

This document traces the complete AAC session startup flow from client to server to Gemini,
identifies the root causes of startup failures, and proposes fixes.

---

## 1. Complete Startup Sequence (as-is)

### Step 1: Client triggers initialization

**File:** `client-aac/src/components/DualAgentConversationBox.tsx:203-207`

```
useEffect: isVisible && !isInitialized && !isLoading → initialize()
```

When the DualAgentConversationBox becomes visible, it calls `initialize()` from the
`useDualAgentContext()` hook, which delegates to `useLiveSession.initialize()`.

### Step 2: Client opens WebSocket and sends `initialize` message

**File:** `client-aac/src/hooks/useLiveSession.ts:567-690`

1. Captures an initial camera frame (best-effort, non-blocking)
2. Opens a WebSocket to `{apiBase}/ws/live`
3. On `ws.onopen`:
   - Sends any cached local state: `{ type: "local_state", snapshot }`
   - Sends: `{ type: "initialize", studentId, userId, interactionMode, responseMode, debugMode, initialFrame? }`
4. Registers `ws.onmessage` → `handleServerMessage`
5. Registers `ws.onclose` → auto-reconnect after 3s if `isInitialized`

### Step 3: Server creates LiveRelay, receives `initialize`

**File:** `server/services/dual-agent/live-relay.ts:322-352` (constructor)

The WebSocket server creates a `LiveRelay` instance per connection. The `LiveRelay` constructor
registers `ws.on("message")` to dispatch to `handleClientMessage()`.

**File:** `server/services/dual-agent/live-relay.ts:710-1019` (`handleInitialize`)

This is the main initialization method. It does (in order):

1. **Read LLM config** (line 723): `settingsRepository.getLLMConfig('aac_chat')` — determines model/provider
2. **Determine model type** (lines 741-745): GA native audio vs preview
3. **Initialize session** (line 749): `dualAgentService.initializeSession(...)` — creates/resumes
   session, builds system prompt, resolves contacts/symbols/boards
4. **Get session cache** (line 760): retrieves `SessionCache` with state/agents
5. **Resolve voices** (line 776): determines AI voice and student voice for TTS
6. **Determine direct audio mode** (line 800): if no ElevenLabs + low interpretation → model speaks directly
7. **Build tool declarations** (line 806): `buildToolDeclarations(toolConfig)` — Gemini format with `parametersJsonSchema`
8. **Close existing provider** (line 823): for forceNewSession re-init
9. **Create GeminiLiveProvider** (line 844): with Vertex AI if GA model
10. **Build provider config** (lines 830-873): model, temperature, tools, modality, voice, proactiveAudio
11. **Rebuild prompt for direct audio** (lines 876-908): if useDirectAudio, rebuilds prompt without speak() references
12. **Connect to Gemini** (line 915): `await this.provider.connect(systemPrompt, providerConfig)` ← KEY AWAIT
13. **Log session** (lines 919-935): SESSION START, SYSTEM PROMPT, TOOL DECLARATIONS
14. **Start periodic reminders** (line 938): board reminder (45s), behavioral reminder (3min)
15. **Resolve local storage config** (lines 943-963)
16. **Send `initialized` to client** (line 966): `{ type: "initialized", sessionId }`
17. **Set `initialConnectionDone = true`** (line 995) ← KEY FLAG
18. **Schedule greeting prompt** (lines 1002-1017): with 3000ms delay for AUDIO modality

### Step 4: Gemini sends `setupComplete` → `onReady` fires

**File:** `server/services/dual-agent/gemini-live-provider.ts:378-381`

When Gemini's `setupComplete` message arrives (AFTER `connect()` returns), `onReady` is called.

**File:** `server/services/dual-agent/live-relay.ts:392-409` (`onReady` callback)

```javascript
onReady: () => {
    this.reconnectAttempts = 0;
    if (this.initialConnectionDone) {      // ← TRUE (set in step 17)
        this.send({ type: "reconnected" }); // ← WRONG: sends "reconnected" on initial connect!
        if (!this.hasGreeted) {
            // Sends FIRST greeting (simplified, no persona hint)
            this.provider!.sendMessage("Call rebuild_board()...", "user");
        }
    }
}
```

**BUG #1: `onReady` is designed for reconnections but fires on initial connection too.**
Because `initialConnectionDone` is set in step 17 (before `setupComplete` arrives), `onReady`
treats the initial connection as a reconnection and sends a greeting prompt.

### Step 5: First greeting → empty model turn

The model receives: `"Call rebuild_board() with 4-12 initial communication buttons, then greet the user."`
(from `onReady`, with `turnComplete=true`)

**Response:** `outputTranscription("(empty)")`, `generationComplete`, `TURN_COMPLETE` — NO tool calls, NO audio, NO text.

The relay sees `turnStartTime === 0` (no tool calls arrived to set it), logs "SKIPPED: empty turn".

### Step 6: Delayed greeting (3s later) → another empty model turn

**File:** `server/services/dual-agent/live-relay.ts:1003-1012`

The setTimeout fires, sending the SECOND greeting with persona hint:
`"Call rebuild_board() with 4-12 initial communication buttons, then greet the user with your voice. [persona hint]"`

**Same result:** empty model turn. No tool calls, no output.

### Step 7: Visual checks begin → all empty

The activity monitor starts sending frame grids with `[VISUAL CHECK]` prompts every ~7-15 seconds.
ALL of these also produce empty model turns.

### Step 8: Board reminder fires (45s)

Since no board updates have happened (`boardButtonLabels` is empty), the board reminder fires:
`[BOARD STATE REMINDER] Current buttons (0/12, 12 slots available): none`
(sent as `sendContextInjection` with `turnComplete=false` — doesn't trigger a response)

---

## 2. Root Cause Analysis

### BUG #1: `onReady` race condition — duplicate greeting on initial connection

**Cause:** `initialConnectionDone` is set at line 995, BEFORE `setupComplete` arrives from Gemini.
When `onReady` fires (after `setupComplete`), it sees `initialConnectionDone = true` and
incorrectly treats this as a reconnection scenario.

**Effect:**
- Sends `{ type: "reconnected" }` to the client on initial connect (harmless but confusing)
- Sends a simplified greeting prompt (without persona hint) → this is the FIRST greeting
- 3 seconds later, the setTimeout sends the FULL greeting prompt → this is the SECOND greeting
- The model receives two greeting prompts in quick succession

**Why it happens:** `GeminiLiveProvider.connect()` returns after the WebSocket opens and the
session config is sent. The `setupComplete` message arrives asynchronously on a later event
loop tick, by which time `handleInitialize` has already set `initialConnectionDone = true`.

### BUG #2: Model returns empty turns for ALL inputs

**Symptom:** The Gemini model returns `TURN_COMPLETE` with no content — no tool calls, no audio,
no text. This happens for every input type: greeting prompts, visual checks, button presses.

**Evidence from log:**
```
SERVER → serverContent: outputTranscription("(empty)")
SERVER → serverContent: generationComplete
SERVER → serverContent: TURN_COMPLETE
```

No `modelTurn.parts` messages are ever received. The model generates nothing.

**Most likely cause: `proactiveAudio: false` with AUDIO response modality**

The provider config sets:
```javascript
proactiveAudio: this.useDirectAudio ? true : false,
responseModality: "AUDIO",
```

When `useDirectAudio` is `false` (most sessions — when ElevenLabs is configured or interpretation
level > 1), `proactiveAudio` is set to `false`.

Per Gemini docs, `proactiveAudio: false` means "the model will only generate audio in response
to user audio." Since the greeting and visual checks are sent as TEXT via `sendClientContent`,
the model may be suppressing ALL output (including function calls) because it's waiting for
actual audio input before responding.

**This is the critical issue.** The model is in AUDIO mode but all prompts are sent as text.
With `proactiveAudio: false`, the model treats text-only input as non-triggering context and
produces empty turns.

**Secondary possible cause: Tool declaration format**

Tools use `parametersJsonSchema` (a `@google/genai` SDK field). The SDK should convert this
to the correct format for Vertex AI, but if conversion fails silently, the model would receive
tools without parameter schemas and might not know how to call them.

### BUG #3: Unnecessary 3-second greeting delay

**Cause:** Line 1002: `const greetingDelay = isAudioModality ? 3000 : 0;`

Comment says "Native audio AUDIO-modality models produce garbage audio tokens during warmup."

**Effect:** Creates a 3-second window between when `onReady` fires (sending the first greeting)
and when the "real" greeting is sent. This worsens BUG #1 by ensuring the model processes the
wrong greeting first.

### BUG #4: Client auto-reconnect creates entirely new sessions

**File:** `client-aac/src/hooks/useLiveSession.ts:665-679`

```javascript
ws.onclose = (event) => {
    if (isInitialized) {
        reconnectTimerRef.current = setTimeout(() => initialize(), 3000);
    }
};
```

When the WebSocket closes (for any reason), the client calls `initialize()` which opens a
NEW WebSocket and sends a NEW `initialize` message. This creates an entirely new Gemini session
on the server, losing all conversation context.

The `isInitialized` check uses React state, which may be stale in the closure.

---

## 3. Key State Flags and Their Roles

| Flag | Set when | Cleared when | Purpose |
|------|----------|--------------|---------|
| `initialConnectionDone` | After connect + logging (line 995) | Never cleared | Distinguishes initial connect from reconnect in `onReady` |
| `awaitingModelResponse` | When sending turnComplete=true message | When tool call arrives OR empty turn skipped | Prevents overlapping requests to model |
| `turnProcessingBusy` | When processing tool calls in `handleProviderTurnComplete` | After `processTurnEnd` completes | Prevents concurrent turn processing |
| `turnStartTime` | First tool call in a turn (line 1168) | After turn processing completes | Detects empty turns (0 = no tool calls received) |
| `hasGreeted` | When speak() tool is called with text (line 1276) or direct audio received | Never cleared | Tracks whether model has greeted user |
| `consecutiveModelTurns` | Incremented after each turn completes | Reset to 0 on user input | Tracks rapid model turns without user input |

---

## 4. The "Empty Turn" Problem in Detail

When the model returns TURN_COMPLETE with no content, the relay does:

```javascript
// live-relay.ts:1761
if (this.turnStartTime === 0 && !hasDirectAudio) {
    this.awaitingModelResponse = false;
    logLiveSession(`RELAY #${seq} SKIPPED`, `empty turn`);
    return;
}
```

`turnStartTime` is only set when `handleToolCalls` is called (line 1168). If the model never
makes tool calls, `turnStartTime` stays at 0 and the turn is skipped.

The `awaitingModelResponse` flag IS cleared, which allows subsequent frame_grids to be sent.
But those also get empty responses, creating the pattern seen in the log.

---

## 5. Diagnosis Steps Needed

To confirm the root cause of empty turns, add logging for:

1. **Raw Gemini messages**: Log ALL fields of every `LiveServerMessage`, not just `serverContent`
2. **setupComplete timing**: Log timestamp of `setupComplete` relative to `initialConnectionDone`
3. **Adapted tools verification**: Log whether `parametersJsonSchema` was properly handled by the SDK
4. **Test with `proactiveAudio: true`**: If the model responds with proactiveAudio:true, that confirms
   the suppression hypothesis

---

## 6. Proposed Fixes

### Fix 1: Prevent `onReady` from sending greeting on initial connection

Move `initialConnectionDone = true` to AFTER the greeting is sent, or add a separate
`greetingSent` flag that `onReady` checks.

### Fix 2: Fix `proactiveAudio` setting

For non-directAudio sessions, `proactiveAudio` should still be `true` (or at least not `false`)
so the model responds to text input. The concern about "proactive audio" is about the model
spontaneously starting conversations — it should NOT prevent responding to explicit user messages.

Alternatively, if `proactiveAudio: false` truly suppresses text-triggered responses, we need a
different approach to prevent unwanted model turns (perhaps using `activityHandling` settings
or only suppressing after the initial greeting).

### Fix 3: Remove the 3-second greeting delay

The delay creates race conditions and slows startup. If warmup audio is a concern, handle it
by discarding the first few hundred ms of audio output, not by delaying the prompt.

### Fix 4: Send greeting only once, from a single code path

The greeting should be sent from ONE place only — either in `handleInitialize` after setup is
confirmed, or in `onReady`. Not both.

### Fix 5: Restructure `onReady` for initial vs reconnection

`onReady` should clearly distinguish between initial connection and reconnection:
```javascript
onReady: () => {
    if (!this.initialConnectionDone) {
        // Initial connection — greeting will be sent by handleInitialize
        this.initialConnectionDone = true;
        return;
    }
    // Reconnection — inject context or re-send greeting
    ...
}
```

This makes `initialConnectionDone` be set BY onReady instead of before it, eliminating the race.

---

## 7. Fixes Applied

All fixes below have been implemented:

1. **onReady race condition fixed**: `initialConnectionDone` is now set BY `onReady` on the
   initial connection. `handleInitialize` stores the greeting prompt in `pendingGreetingPrompt`
   and `pendingGreetingFrame`. `onReady` sends it after `setupComplete` confirms the session
   is ready. No duplicate greeting.

2. **proactiveAudio set to `true` always**: Both GA and preview paths now use
   `proactiveAudio: true`. The model can respond to text input and make tool calls.

3. **3-second greeting delay removed**: The greeting is sent as soon as `setupComplete` arrives
   (via `onReady`), with no artificial delay.

4. **Interpretation level branching removed**: All code paths now use level 1 behavior.
   - `interpret()` tool removed from tool declarations
   - `interpretationLevel` removed from `ToolDeclarationConfig`, `DualAgentSessionState`,
     `buildFunctionCallingPrompt`, session creation, behavioral reminders
   - Buttons always include sentences (level 1 format: `label|icon|imageKey|sentence`)
   - Pre-generated student TTS always active on button press
   - Echo awareness simplified (no interpret tool references)
   - Behavioral reminder simplified (single interpretation rule)

5. **Diagnostic logging added** for next debugging session:
   - `RAW_MSG`: All raw Gemini server messages with content analysis
   - `SETUP_COMPLETE`: Timestamp of setupComplete
   - `CONNECT_RETURNED`: Config details after connect()
   - `ON_READY (initial/reconnect)`: Which path onReady took

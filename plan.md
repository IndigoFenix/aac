# Gemini Live API Migration Plan

## Goal

Replace the current half-duplex HTTP request-response detection/message pipeline with a persistent bidirectional WebSocket session using the Gemini Live API. This eliminates per-request overhead, removes the inflight mutex, and gives the model continuous visual/audio context.

## Architecture Overview

```
Browser ←— WebSocket —→ Express Server ←— WebSocket —→ Gemini Live API
         (ws on /ws/live)              (@google/genai Session)
```

The server acts as a relay between the client and Gemini. The client never talks to Gemini directly (API key stays server-side). Server-side processing (prefix token parsing, TTS synthesis, contact enrollment, monitor agent triggering) happens in the relay layer.

**Response mode: TEXT** (not AUDIO). Reasons:
- Preserves the existing prefix token system ([SPEAK], [INTERPRET], [ADD_BUTTONS], etc.)
- Keeps per-student ElevenLabs voices (already configured)
- Function calling not needed — prefix tokens already handle structured output
- Simpler migration path

## What Stays the Same

- **Frame ring buffer + grid composition** — client still captures frames at 4fps into a 64-slot ring buffer and composes 4x4 grids (the user explicitly wants to keep this)
- **Activity monitor** — still detects speech boundaries, motion settle, heartbeat. Instead of triggering HTTP POST, it sends the grid over WebSocket
- **Prefix token parsing** — same `StreamingPrefixParser` / `parseStreamedText` in interactive-agent.ts
- **ElevenLabs TTS** — same per-student voices, synthesized server-side
- **Monitor agent** — still runs on 2-min throttle, injected via `[CONTEXT]`
- **Board management** — same [ADD_BUTTONS], [REBUILD_BOARD], [REMOVE_BUTTONS] tokens
- **Face recognition** — client-side face-api.js, face image cache, contact enrollment
- **All app functionality** — YouTube, Drawing, Music apps unchanged
- **Debug panel** — same data, just sourced from WebSocket events instead of SSE

## What Changes

| Current | New |
|---------|-----|
| HTTP POST `/detect` per activity trigger | WebSocket message `frame_grid` sent to server, relayed to Gemini via `sendRealtimeInput` |
| HTTP POST `/message` + SSE response | WebSocket message `user_message`, relayed via `sendClientContent` |
| HTTP POST `/voice` + SSE response | WebSocket message `voice_audio`, relayed via `sendClientContent` |
| HTTP POST `/initialize` + SSE response | WebSocket `open` → server creates Gemini session with system prompt |
| System prompt sent with EVERY request (~6K tokens) | System prompt sent ONCE at session start |
| `inflightRef` mutex prevents concurrent requests | No mutex needed — WebSocket is full-duplex |
| Response blocks next detection | Model responds asynchronously, no blocking |
| Separate message histories (client tracks, server rebuilds) | Gemini maintains conversation state server-side |

## Cost Analysis

### Current System (per hour of active use)
- ~10-20 detections/minute, each sending: system prompt (~2K tokens) + context (~1K) + image (~258) + instruction (~500)
- **Input**: ~3,750 tokens × 600-1,200 calls = **2.25M–4.5M tokens/hour**
- **Output**: ~200 tokens × 600-1,200 calls = **120K–240K tokens/hour**
- **Cost** (gemini-2.5-flash): ($0.15 × 2.25-4.5) + ($0.60 × 0.12-0.24) = **$0.41–$0.82/hour**

### Live API (per hour, sending grids every 5s)
- System prompt: **2K tokens** (sent once, not repeated)
- Video frames: 258 tokens × 12/minute × 60 = **185K tokens/hour**
- Context updates (text injections): ~**50K tokens/hour**
- **Total input: ~237K tokens/hour** → **$0.036/hour**
- **Output** (model responds only when relevant): ~**100K tokens/hour** → **$0.060/hour**
- **Total: ~$0.10/hour** (4-8x cheaper than current)

### Key savings
1. **No repeated system prompt** — currently 2K tokens × 600+ calls/hour = 1.2M+ wasted tokens
2. **Proactive silence** — model doesn't generate output when nothing noteworthy happens
3. **No duplicate context** — Gemini maintains state, no need to re-send conversation history

### Long session costs (8-hour school day)
- Current: **$3.28–$6.56**
- Live API: **~$0.80**

### Adding continuous audio (optional)
- 25 tokens/second × 3600 = 90K tokens/hour → +$0.014/hour (negligible)
- Enables Gemini's built-in VAD, could replace client-side speech boundary detection

---

## Implementation Phases

### Phase 1: Server — Gemini Live Session Manager

**New file: `server/services/dual-agent/live-session.ts`**

Manages a single Gemini Live API WebSocket session per AAC session.

```ts
class GeminiLiveSession {
  private session: Session | null = null;
  private resumptionHandle: string | null = null;

  // Lifecycle
  async connect(systemPrompt: string, config: LiveSessionConfig): Promise<void>
  async reconnect(): Promise<void>  // Uses session resumption
  close(): void

  // Sending
  sendFrame(jpegBlob: Buffer): void           // sendRealtimeInput({video})
  sendAudio(pcmBuffer: Buffer): void           // sendRealtimeInput({audio})
  sendMessage(text: string, role?: string): void  // sendClientContent({turns})
  sendContextInjection(text: string): void     // sendClientContent, system-like

  // Callbacks (set by the relay layer)
  onText: (text: string) => void
  onTurnComplete: () => void
  onInterrupted: () => void
  onInputTranscription: (text: string) => void
  onToolCall: (calls: FunctionCall[]) => void
  onError: (error: Error) => void
}
```

**Key decisions:**
- Uses `response_modalities: ["TEXT"]` — preserves prefix token system
- Sets `contextWindowCompression` with sliding window for long sessions
- Stores `resumptionHandle` for transparent reconnection on session timeout
- Auto-reconnects when session expires (2-min video / 15-min audio limits)
- Disables safety settings (same as current GeminiChatProvider)

### Phase 2: Server — WebSocket Relay Endpoint

**New file: `server/services/dual-agent/live-relay.ts`**

Bridges the client WebSocket to the Gemini Live session, with server-side processing.

**New route in `server/routes.ts`:**
```ts
// WebSocket upgrade for live AAC sessions
server.on('upgrade', (req, socket, head) => {
  // Authenticate, extract studentId/sessionId from query params
  // Create LiveRelay instance
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});
```

**LiveRelay responsibilities:**
1. **Client → Gemini**: Receive client messages, relay to Gemini session
   - `frame_grid` → decode JPEG → `geminiSession.sendFrame()`
   - `user_message` → `geminiSession.sendMessage(text, "user")`
   - `voice_audio` → transcribe via Whisper → `geminiSession.sendMessage(transcript, "user")`
   - `gesture_context` + `person_context` → aggregate, send as context
   - `interpret_buttons` → build interpretation prompt → `geminiSession.sendMessage()`

2. **Gemini → Client**: Parse model output, process, relay to client
   - Accumulate text chunks from `onText` callback
   - Run through `StreamingPrefixParser` (same as current interactive-agent.ts)
   - For `[SPEAK]` → synthesize TTS via ElevenLabs → send text + audio to client
   - For `[INTERPRET]` → synthesize with student voice → send to client
   - For `[ADD_BUTTONS]`/`[REBUILD_BOARD]`/`[REMOVE_BUTTONS]` → send board_patch
   - For `[EMOTE]` → send emote event
   - For `[PLAY_VIDEO]` → YouTube search → send video_play event
   - For `[LEARN_FACE]` → create/update contact → send to client
   - For `[CALL_MONITOR]` → trigger monitor agent
   - For `[TRANSCRIPT]`/`[CONTEXT]` → forward to client

3. **Monitor agent integration**: Same throttled monitor, but context injections go via `sendClientContent` instead of rebuilding the system prompt

**Client → Server message protocol:**
```ts
type ClientMessage =
  | { type: "frame_grid"; data: string; timestamps: number[] }  // base64 JPEG
  | { type: "audio_clip"; data: string; mimeType: string }      // base64 audio
  | { type: "user_message"; text: string }
  | { type: "voice_audio"; data: string }                       // base64 webm
  | { type: "interpret_buttons"; buttons: string[]; board?: any }
  | { type: "gesture_context"; data: string }
  | { type: "person_context"; data: any }
  | { type: "board_state"; data: any }
  | { type: "set_mode"; mode: "interact" | "silent" }
  | { type: "set_response_mode"; mode: "fast" | "analyze" }
```

**Server → Client message protocol:**
```ts
type ServerMessage =
  | { type: "initialized"; sessionId: string }
  | { type: "text"; data: string }
  | { type: "speak"; text: string; audio?: string }
  | { type: "interpret"; text: string; audio?: string }
  | { type: "board_patch"; data: BoardPatch }
  | { type: "board"; data: ParsedBoardData }
  | { type: "transcript"; data: string; speaker: string }
  | { type: "context"; data: string }
  | { type: "emote"; data: string }
  | { type: "video_play"; data: any }
  | { type: "debug"; data: any }
  | { type: "error"; data: string }
  | { type: "thinking"; active: boolean }
```

### Phase 3: Client — WebSocket Hook

**New file: `client-aac/src/hooks/useLiveSession.ts`**

Replaces `useDualAgent.ts` as the primary communication hook.

```ts
function useLiveSession(options: LiveSessionOptions): LiveSessionReturn {
  // WebSocket connection management
  const wsRef = useRef<WebSocket | null>(null);

  // Connect on mount, reconnect on disconnect
  // Send frames/audio/messages via ws.send(JSON.stringify({...}))
  // Parse incoming messages, dispatch to state

  return {
    // Same interface as current useDualAgent where possible
    sessionId, isInitialized, isLoading, error,
    currentMessage, transcription, interpretationText,
    audioEnabled, isPlaying, voiceEnabled, isRecording,
    interactionMode, setInteractionMode,
    responseMode, setResponseMode,
    videoCaptureEnabled, setVideoCaptureEnabled,

    // Actions — now just send WebSocket messages
    initialize,              // opens WS connection
    sendMessage,             // ws.send({type: "user_message"})
    sendFrameGrid,           // ws.send({type: "frame_grid"})
    sendAudioClip,           // ws.send({type: "audio_clip"})
    interpretButtons,        // ws.send({type: "interpret_buttons"})
    startVoiceRecording,
    stopVoiceRecording,

    // Board, debug, emote, etc. — same as current
    boardPatch, debugData, emote, speakingVolume,
    activeApp, dismissApp,
  }
}
```

**Key changes from current `useDualAgent`:**
- No `inflightRef` mutex — WebSocket is non-blocking
- No SSE parsing — messages come as JSON over WebSocket
- `runDetectionWithGrid()` becomes `sendFrameGrid()` — fire-and-forget, no waiting
- Audio playback still uses `useStreamingAudioPlayer` (receives base64 audio from server)

### Phase 4: Client — Wire into DualAgentContext

**Modify: `client-aac/src/contexts/DualAgentContext.tsx`**

- Replace `useDualAgent` with `useLiveSession`
- Activity monitor's `onTrigger` callback now calls `sendFrameGrid()` instead of `runDetectionWithGrid()`
- No need for `captureFrame` prop — frames still come from ring buffer via activity monitor
- Remove mic stream management (if using continuous audio through Gemini's VAD)

### Phase 5: Session Management & Reconnection

**In `live-session.ts`:**
- Handle `sessionResumptionUpdate` events — store new handles
- On WebSocket close/error → automatic reconnection with handle
- On session timeout (2 min video, 15 min audio) → transparent reconnect
- On context window compression events → log for debugging
- Client WebSocket disconnect → close Gemini session, clean up state
- Client WebSocket reconnect → resume Gemini session with handle

### Phase 6: Cleanup & Fallback

- Keep existing HTTP endpoints as fallback (for non-Live-API providers like OpenAI/Claude)
- Add a `useLiveApi` flag to session config to toggle between Live and HTTP modes
- Remove `inflightRef` mutex from client when using Live mode
- Update debug panel to show Live API specific metrics (session duration, reconnection count, token usage from `usageMetadata`)

---

## Files Modified/Created

| File | Action |
|------|--------|
| **NEW** `server/services/dual-agent/live-session.ts` | Gemini Live API session manager |
| **NEW** `server/services/dual-agent/live-relay.ts` | Server-side WebSocket relay + prefix token processing |
| **NEW** `client-aac/src/hooks/useLiveSession.ts` | Client WebSocket hook (replaces useDualAgent for Live mode) |
| `server/routes.ts` | Add WebSocket upgrade handler |
| `client-aac/src/contexts/DualAgentContext.tsx` | Wire useLiveSession, simplify activity trigger |
| `client-aac/src/hooks/useActivityMonitor.ts` | Change trigger callback to send over WS |
| `server/services/dual-agent/dual-agent-service.ts` | Extract shared logic (prefix parsing, TTS, monitor) for reuse |
| `server/services/dual-agent/interactive-agent.ts` | Extract `StreamingPrefixParser` for reuse |
| `client-aac/src/components/UnifiedDebugPanel.tsx` | Add Live session metrics |

## What Does NOT Change

- `server/services/memory-schema/aac-memory-schema.ts` — same prompts
- `server/services/dual-agent/types.ts` — same types (extended, not replaced)
- `server/services/biometric/` — unchanged
- `client-aac/src/lib/frameRingBuffer.ts` — unchanged
- `client-aac/src/lib/composeFrameGrid.ts` — unchanged
- `client-aac/src/lib/audioActivityMonitor.ts` — unchanged (or optional: remove if using Gemini VAD)
- `client-aac/src/hooks/usePersonIdentification.ts` — unchanged
- `client-aac/src/hooks/useFaceImageCache.ts` — unchanged
- All app components (YouTube, Drawing, Music) — unchanged
- ElevenLabs TTS pipeline — unchanged
- Monitor agent — same logic, different injection method

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| 2-min session limit with video | Session resumption with transparent reconnect (every ~90s proactively) |
| Live API is `@experimental` | Keep HTTP fallback, feature flag to switch |
| Model responds too often to uninteresting frames | System prompt guidance + proactivity setting + "respond only when noteworthy" instructions |
| Model responds too rarely | Heartbeat injection via sendClientContent every 15s asking for status |
| WebSocket disconnection | Auto-reconnect with exponential backoff, buffer pending messages |
| Context window exhaustion in long sessions | Enable `contextWindowCompression` with sliding window trigger |
| Cost overrun if frame rate too high | Configurable frame send rate (default: match activity monitor's ~every 5s) |

## Implementation Order

1. **Phase 1** first — can be tested independently against Gemini
2. **Phase 2** next — server relay can be tested with a simple WebSocket client
3. **Phase 3 + 4** together — client hooks + context wiring
4. **Phase 5** — hardening (reconnection, session management)
5. **Phase 6** — cleanup and feature flag

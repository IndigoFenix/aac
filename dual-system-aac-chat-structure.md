# Dual AAC Chat System (Monitor + Interactive)

## Overview

A dual-agent AAC system that balances two competing goals: fast, context-aware interaction with the student, and deep database operations (memory, goals, notes). Two agents run concurrently — one lightweight and fast, the other supervisory and thorough.

## Architecture

### Interactive Agent (`interactive-agent.ts`)
- Handles all real-time interaction with the student
- Uses a configurable LLM provider (currently Gemini) for fast responses
- Processes both messages (streaming via SSE) and detection frames (camera + audio, JSON response)
- All output is text-based using **prefix tokens** — no tool calls
- Supports two interaction modes:
  - **Interact**: AI talks to the student, buttons are short response options
  - **Silent**: AI is invisible, buttons are full utterances the student can speak to others

### Monitor Agent (`monitor-agent.ts`)
- Supervisory agent that manages memory, tracks goals, and guides the Interactive Agent
- Uses the session service and structured memory system for database reads/writes
- Initializes the Interactive Agent's system prompt based on student profile and context
- Injects guidance via `[CONTEXT]` and `[UPDATE_PROMPT]` command tags
- **Throttled to 2-minute intervals** to reduce LLM costs, unless force-triggered

### Orchestrator (`dual-agent-service.ts`)
- Coordinates both agents, manages session state, TTS, and credit tracking
- Handles session caching with 30-minute TTL and database persistence
- Uses mutex-based concurrency control for monitor processing
- Pending messages accumulate while the monitor is busy or throttled, then batch-process

## Prefix Token Protocol

The Interactive Agent outputs all responses as plain text with prefix tokens, parsed by `StreamingPrefixParser` for streaming and `parseStreamedText` for non-streaming. Tokens must appear in this order:

| Token | Purpose | Notes |
|-------|---------|-------|
| `[TRANSCRIPT speaker] text` | Record voice heard | Speaker identity (e.g., "Mom", "Teacher") |
| `[CONTEXT] observations` | Record environment changes | New objects, gestures, sounds |
| `[SPEAK] message` | AI voice output | Mutually exclusive with INTERPRET |
| `[INTERPRET] message` | Student voice output | Only with HIGH CONFIDENCE signals |
| `[ADD_BUTTONS] label\|icon, ...` | Add buttons incrementally | Detection mode |
| `[REMOVE_BUTTONS] label, ...` | Remove buttons by label | Detection mode |
| `[REBUILD_BOARD] label\|icon, ...` | Replace entire board | Message mode |
| `[CALL_MONITOR] reason` | Request early supervisor check-in | Bypasses 2-min throttle |

All tokens are optional. Omit if nothing to report.

## Monitor Throttling & [CALL_MONITOR]

To reduce LLM costs, the monitor is throttled to run at most once every 2 minutes (`MONITOR_THROTTLE_MS = 120_000`). Pending messages accumulate during the throttle window and are batch-processed when the monitor next runs.

The Interactive Agent can bypass the throttle by outputting `[CALL_MONITOR] reason`, which:
1. Pushes the reason as a pending message so the monitor sees why it was called
2. Force-triggers `tryTriggerMonitor()` with `force=true`, bypassing the time check
3. The monitor can guide the Interactive Agent on *when* to call it via `[CONTEXT]` injection

Use cases for `[CALL_MONITOR]`:
- Progress or setbacks on student goals
- Significant context shifts (new person, new activity, location change)
- Needing guidance on how to handle a situation

## Continuous Detection Pipeline

The detection system uses an **activity-driven** approach instead of fixed-interval polling. Frames and audio are collected continuously on the client, and detection triggers fire based on observed activity.

### Pipeline Architecture

```
CameraAttentivenessContext          AudioActivityMonitor
  (captures frames at 4fps,          (records audio continuously,
   detects motion, sleep/wake)         detects speech boundaries)
          |                                    |
     FrameRingBuffer                  Rolling audio chunks
  (stores recent 64 frames            (5s webm segments)
   with timestamps + motion)
          |                                    |
                 useActivityMonitor (orchestrator hook)
                 - Consumes both data sources
                 - Detects "activity settled" moments
                 - Fires detection trigger
                          |
               composeFrameGrid() (utility)
               - Selects most important frames (up to 16)
               - Composites into 4x4 grid with timestamps
               - Flips + adds L/R labels
                          |
                  useDualAgent.runDetectionWithGrid()
                  - Sends composite grid + audio clip + frameTimestamps
                  - Backend processes as single image with grid context
```

### Trigger Conditions

The activity monitor uses a state machine with these trigger rules:

1. **Speech ended** — After 1.5s of silence following detected speech
2. **Motion settled** — After 1.5s of low motion following significant motion
3. **Heartbeat** — If 15s elapsed since last send with no triggers
4. **Min interval guard** — Never sends more frequently than every 3s

### Frame Selection Algorithm

When more frames are available than grid slots (16), the `composeFrameGrid` utility selects frames that maximize both temporal coverage and visual diversity:
1. Always includes first and last frames
2. Scores remaining frames by temporal spread + motion level
3. Greedy selection of highest-scoring frames
4. Arranges chronologically in 4x4 grid (left-to-right, top-to-bottom)

Each sub-frame (160x120px) has a timestamp overlay (`+0.0s`, `+1.2s`, etc.) relative to the first frame.

### Audio Recording

- Continuously records in rolling 5-second chunks via MediaRecorder
- When a trigger fires, sends the most recently completed audio chunk
- New chunk starts immediately (no gap)
- Falls back gracefully if mic is unavailable

### Client Components

| File | Purpose |
|------|---------|
| `client-aac/src/lib/frameRingBuffer.ts` | Circular buffer for camera frames (64 slots) |
| `client-aac/src/lib/composeFrameGrid.ts` | Frame selection + grid composition |
| `client-aac/src/lib/audioActivityMonitor.ts` | Audio energy + speech boundary detection |
| `client-aac/src/hooks/useActivityMonitor.ts` | Orchestrator: trigger logic + data collection |

### Backend Grid Context

When `frameTimestamps` is provided, the detection prompt includes a grid layout description:

```
== Composite Grid ==
This image is a composite grid of 12 camera frames arranged left-to-right, top-to-bottom.
Each sub-frame is timestamped relative to the first frame:
Row 1: +0.0s, +0.3s, +0.5s, +1.2s
Row 2: +1.8s, +2.1s, +2.5s, +3.0s
Row 3: +3.5s, +4.0s, +4.5s, +5.0s
Observe changes across frames to understand motion, gestures, and temporal context.
```

## Session Management

- Session state stored in `chat_sessions` table with pending messages, interactive prompt, and flags
- In-memory cache (`sessionCache`) with mutex per session for monitor concurrency
- Stale `monitorBusy` flags auto-reset after 30 seconds (crash recovery)
- Sessions evicted from cache after 30 minutes of inactivity

## Key Files

| File | Purpose |
|------|---------|
| `server/services/dual-agent/types.ts` | Core type definitions |
| `server/services/dual-agent/interactive-agent.ts` | LLM interaction, prefix token parsing |
| `server/services/dual-agent/monitor-agent.ts` | Supervisory agent, memory management |
| `server/services/dual-agent/dual-agent-service.ts` | Orchestration, TTS, session management |
| `server/services/memory-schema/aac-memory-schema.ts` | Prompt builders + memory field schema |
| `server/controllers/dualAgentController.ts` | Express endpoints |
| `client-aac/src/hooks/useDualAgent.ts` | React hook for SSE + activity-driven detection |
| `client-aac/src/hooks/useActivityMonitor.ts` | Activity monitor orchestrator hook |
| `client-aac/src/contexts/DualAgentContext.tsx` | React context: wires up activity monitor + mic |
| `client-aac/src/lib/frameRingBuffer.ts` | Circular buffer for camera frames |
| `client-aac/src/lib/composeFrameGrid.ts` | Grid composition utility |
| `client-aac/src/lib/audioActivityMonitor.ts` | Audio energy + speech detection |

## Interaction Modes

### Interact Mode
- AI speaks to the student via `[SPEAK]`
- Buttons are short response options (1-3 words)
- Both text and audio are streamed to the client

### Silent Mode
- AI is invisible — never uses `[SPEAK]`
- Buttons are complete utterances the student can speak aloud to others
- `[INTERPRET]` is used to speak on behalf of the student (student voice TTS)

## TTS Voices

Two separate voices are resolved per session:
- **AI Voice** (`aiVoice`): Used for `[SPEAK]` output
- **Student Voice** (`studentVoice`): Used for `[INTERPRET]` output and button interpretation

Both support custom voice records (cloned voices) with fallback to preset voice types.

## Guidelines

- Session objects are cached in-memory but always have a database fallback (the backend may be short-lived)
- All session-specific data is stored in a single `chat_sessions` row
- Avoid multiple agents writing to the same session column simultaneously — pending messages solve this
- Credit tracking updates `chatSessions`, `students`, `users`, and `userStudents` tables

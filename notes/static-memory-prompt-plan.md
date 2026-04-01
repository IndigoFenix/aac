# Static Memory Prompt Mode — Implementation Plan

## Goal
Add a global option `staticPromptMode` that changes how the memory system communicates with the LLM:
- **Current (dynamic)**: System prompt is rebuilt every round with all visible data embedded
- **New (static)**: System prompt shows only schema structure. Data lives in tool response messages in conversation history. Prompt only rebuilt with full data on compression.

## Why
- Enables prompt caching (identical system prompt between rounds)
- Reduces token costs (data not duplicated in prompt + tool response)
- Reduces latency (smaller prompts, fewer rebuilds)

## Key Changes

### 1. memory-types.ts
- Add `staticPromptMode?: boolean` to `MemoryState`

### 2. memory-system.ts
- New function `renderMemorySchema()` — renders field names, types, descriptions, constraints, but NO data values
- Includes instruction: "Use manageMemory view to load data. Previously viewed data is in earlier tool responses."
- Schema Hints show all container schemas unconditionally in static mode
- View response already contains rendered data (no change needed)

### 3. prompt-kit.ts
- `buildPromptAndTools`: branch on `staticPromptMode` — call `renderMemorySchema()` instead of `renderMemoryVisualization()`
- System prompt becomes identical across rounds → prompt caching works

### 4. chat-handler.ts
- After `compressHistory`: if static mode, inject a synthetic system message with a full memory snapshot so the AI doesn't lose previously-viewed data that was pruned
- `updateConversation`: no change needed (recursive calls produce same static prompt)
- `getStreamingMdResponse`: already doesn't rebuild prompt between rounds, benefits automatically

### 5. tool-router.ts
- Optional: mutation results (set/add/delete) include a brief confirmation of the new value so the AI doesn't need a separate view call

## Edge Cases
- **`opened: true` fields**: Auto-viewed at session start. In static mode, inject initial view results as a synthetic tool response or system message at conversation start.
- **Switching modes**: The flag is per-session in MemoryState. Changing it mid-session could cause the AI to lose context — only change at session start.
- **Fallback**: Global option to switch back to dynamic mode if static breaks something.

## Activation
- Add to agent template config or session service as a global flag
- Default: dynamic (current behavior) for safety
- Toggle via setting or environment variable

## Files
- `server/services/chat/memory-types.ts`
- `server/services/chat/memory-system.ts`
- `server/services/chat/prompt-kit.ts`
- `server/services/chat/chat-handler.ts`
- `server/services/chat/tool-router.ts`

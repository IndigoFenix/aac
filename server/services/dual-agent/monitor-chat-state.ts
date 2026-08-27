// server/services/dual-agent/monitor-chat-state.ts
//
// The chat-framework state the Monitor runs on, rebuilt by dual-agent-service
// on every save. Pure so it can be unit-tested without the service's DB
// import graph — the one field that matters for cost is easy to break by
// accident:
//
//   memoryState.staticPromptMode MUST be true.
//
// In static mode the memory section of the Monitor's system prompt renders
// schema only (data arrives through manageMemory `view` responses, which live
// in `history`), so the prompt is byte-identical across rounds and runs and
// Claude's prompt cache produces reads (0.1x) instead of a full ~10k-token
// write (1.25x) on every round. With `memoryState: {}` (the pre-2026-08-27
// value) the render was dynamic: cache_read was 0 on every Monitor run, even
// between rounds of the same run. See server/tests/monitor-cache-regression.test.ts.

/**
 * Static-mode memory state. A new object per call; `visible`/`page` reset.
 *
 * `_cachedPrompt` is CARRIED from the prior state when present: static mode's
 * FIRST render still goes through the value-aware renderer (array item
 * counts and the like show up in it) and is then frozen onto the state. If
 * the reset dropped it, every Monitor run re-rendered from current values
 * and the prefix moved whenever the Monitor had written memory since the
 * last run — a cache miss on exactly the runs that follow a note. Carrying
 * the frozen render keeps the prefix byte-identical for the whole session
 * (the CRM/clinician chats keep it the same way, via the persisted state).
 */
export function monitorMemoryState(prior?: unknown): { visible: string[]; page: Record<string, unknown>; staticPromptMode: true; _cachedPrompt?: string } {
  const cached = (prior as { _cachedPrompt?: unknown } | null | undefined)?._cachedPrompt;
  return {
    visible: [],
    page: {},
    staticPromptMode: true,
    ...(typeof cached === "string" && cached.length > 0 ? { _cachedPrompt: cached } : {}),
  };
}

export interface MonitorChatStateInput {
  muteState?: unknown;
  memoryContext?: unknown;
  enhancedSections?: unknown;
  sessionSummary?: unknown;
  summarizedMsgCount?: unknown;
}

/**
 * Build the state row for a save. `history` / `conversationSummary` are the
 * framework's (the Monitor's culled LLM conversation + its summary) and are
 * preserved from the prior row; `openedTopics` and `memoryState` are reset —
 * a static render is deterministic, so the reset costs nothing.
 */
export function buildMonitorChatState(
  priorState: Record<string, unknown> | null | undefined,
  state: MonitorChatStateInput,
): Record<string, unknown> {
  const prior = priorState ?? {};
  return {
    history: prior.history ?? [],
    conversationSummary: prior.conversationSummary ?? "",
    openedTopics: [],
    memoryState: monitorMemoryState(prior.memoryState),
    muteState: state.muteState,
    memoryContext: state.memoryContext,
    enhancedSections: state.enhancedSections,
    sessionSummary: state.sessionSummary,
    summarizedMsgCount: state.summarizedMsgCount,
  };
}

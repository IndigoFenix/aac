// server/services/dual-agent/board-manager-interface.ts
//
// Shared interface for the two Board Manager implementations:
//   - BoardManagerAgent      (Gemini HTTP completion, stateless per invoke)
//   - LiveBoardManagerAgent  (Gemini Live session, TEXT modality + function
//                             calling, persistent warm session)
//
// AgentCoordinator holds either through this interface and chooses which to
// instantiate based on the per-student `boardManagerLiveModel` AAC setting
// (or the AAC_BOARD_MANAGER_MODE env override). Both honor the SAME
// `invoke(input) → BoardManagerInvocationResult` contract, so the
// Coordinator's orchestration (retry chains, fusion feedback, abort,
// force-rebuild directives) is identical regardless of backend.
//
// The Live path is an experiment: a warm session keeps the ~3.8k-token
// system prompt processed across turns to cut board-generation latency. It
// costs MORE per turn (live text rates are ~3× the flash HTTP rates) — the
// trade is latency for cost, and the cost is billed accurately via the
// provider's onUsage callback at the live model's catalog rates.

import type {
  BoardManagerInvocationInput,
  BoardManagerInvocationResult,
} from "./board-manager-agent";
import type { BoardManagerToolConfig } from "./prompts/board-manager";

export interface IBoardManagerAgent {
  /** Stateless-looking contract: hand it a full context snapshot, get back
   *  typed events. The Live implementation hides its persistent session
   *  behind this — each call resolves when the model's turn completes. */
  invoke(input: BoardManagerInvocationInput): Promise<BoardManagerInvocationResult>;

  /** Tear down any underlying provider session. No-op for the HTTP path. */
  close?(): void;

  /** Bind debug-logging session context (Live path forwards to its
   *  provider so SERVER → toolCall logs are attributed). No-op for HTTP. */
  setDebugSessionContext?(sessionId: string, debugMode: boolean, agentLabel?: string): void;

  /** Optionally open the session ahead of the first invoke so the first
   *  board build doesn't pay connect latency. Fire-and-forget; safe to call
   *  on the HTTP path (no-op). */
  prewarm?(systemPrompt: string, toolConfig: BoardManagerToolConfig): void;
}

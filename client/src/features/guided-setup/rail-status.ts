// client/src/features/guided-setup/rail-status.ts
//
// What the Guided Setup rail says while it waits. ONE decision, in priority
// order, so the rail never shows two spinners for one wait and never shows
// none for a wait the user can feel:
//
//   launching   — the flow is opening: the start request, then the kickoff
//                 turn (10–20 s until the assistant's first reply)
//   saving      — one of the rail's own requests is out (skip, dismiss, roster
//                 confirm, consent batch)
//   working     — a chat turn is in flight WHILE the flow is live: the
//                 assistant may be writing the very rows the checklist reads
//   refreshing  — the view is being re-derived after something wrote (a turn
//                 ended, a contact was added, consent was signed)
//
// Before this existed the rail spun on `isBusy` only, so the commonest wait —
// the assistant's turn and then the refetch — looked like nothing, and the
// checklist changed by itself a few seconds later.
//
// `working` is gated on `live` on purpose: with no flow running in this chat a
// turn is just the user chatting, and the rail (compact banner) must not claim
// it as its own.
//
// Pure and dependency-free, like auto-launch.ts, so it is testable without a
// DOM (rail-status.test.ts).

export type RailStatus = 'launching' | 'saving' | 'working' | 'refreshing';

export interface RailStatusInput {
  /** The flow is opening (start request + kickoff turn). */
  isLaunching: boolean;
  /** A rail request is in flight. The provider folds `isLaunching` into this too. */
  isBusy: boolean;
  /** A flow is running in THIS chat. */
  live: boolean;
  /** Any chat turn is in flight. */
  isChatBusy: boolean;
  /** A background refetch of a view already on screen. */
  isRefreshing: boolean;
}

export function railStatus(input: RailStatusInput): RailStatus | null {
  if (input.isLaunching) return 'launching';
  if (input.isBusy) return 'saving';
  if (input.live && input.isChatBusy) return 'working';
  if (input.isRefreshing) return 'refreshing';
  return null;
}

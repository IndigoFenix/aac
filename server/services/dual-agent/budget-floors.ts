// server/services/dual-agent/budget-floors.ts
//
// The budget throttle ladder as DATA: which paid service is still allowed at
// which budget level. Pure, so the ladder is unit-testable without the
// coordinator's import graph, and so every choke point in the coordinator
// (Observer backend, Speaker wake, Board Manager invoke, Monitor heartbeat,
// server-side STT, close-time plan refresh) asks the SAME question instead of
// each re-deriving its own threshold.
//
// Levels (binding budget % — the lowest window, see budget-meter.ts):
//   none        ≥ 25%   everything runs
//   low         < 25%   Live Observer forced to the economy (HTTP) backend
//   board-only  < 10%   no Speaker — presses still voice the student's own
//                       TTS and get response boards
//   all-stop    ≤ 0%    NOTHING paid runs. HARD FLOOR (2026-08-27): applies to
//                       an AWAKE session too (enforceAllStop), not only on
//                       wake — a device in continuous use never idled into the
//                       wake-only floor, and the Monitor / Board Manager / STT
//                       had no gate at all, so a Premium month passed $250.
//
// The one deliberate exception is not on this ladder: the session-close
// Monitor pass + session summary still run at all-stop. They are the clinical
// record of activity that happened while the budget was still positive, cost
// ~$0.1 per session that had any activity, and are skipped for an empty one.
// See planning-docs/aac-budget-tiers-spec.md §3.1 / §5.

export type BudgetFloor = "none" | "low" | "board-only" | "all-stop";

export const BUDGET_LOW_PERCENT = 25;
export const BUDGET_SPEAKER_SLEEP_PERCENT = 10;
export const BUDGET_SHUTDOWN_PERCENT = 0;

export type PaidService =
  | "observer-live"
  | "observer"
  | "speaker"
  | "board-manager"
  | "monitor-heartbeat"
  | "stt"
  | "session-plan-refresh";

export const PAID_SERVICES: readonly PaidService[] = [
  "observer-live", "observer", "speaker", "board-manager", "monitor-heartbeat", "stt", "session-plan-refresh",
];

/** The floor a binding budget percentage puts the session under. */
export function budgetFloor(percent: number): BudgetFloor {
  if (percent <= BUDGET_SHUTDOWN_PERCENT) return "all-stop";
  if (percent < BUDGET_SPEAKER_SLEEP_PERCENT) return "board-only";
  if (percent < BUDGET_LOW_PERCENT) return "low";
  return "none";
}

const DENIED: Record<BudgetFloor, ReadonlySet<PaidService>> = {
  none: new Set(),
  low: new Set(["observer-live"]),
  "board-only": new Set(["observer-live", "speaker"]),
  "all-stop": new Set(PAID_SERVICES),
};

/** Whether `service` may spend under `floor`. */
export function paidServiceAllowed(service: PaidService, floor: BudgetFloor): boolean {
  return !DENIED[floor].has(service);
}

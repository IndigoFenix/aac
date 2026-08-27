// Pins the budget throttle ladder (budget-floors.ts): the level each binding
// budget % maps to, and which paid service survives at each level. The
// coordinator's choke points all consult this table, so the hard floor at 0%
// is exactly "every service denied at all-stop".

import { describe, it, expect } from "@jest/globals";
import {
  budgetFloor,
  paidServiceAllowed,
  PAID_SERVICES,
  BUDGET_LOW_PERCENT,
  BUDGET_SPEAKER_SLEEP_PERCENT,
  BUDGET_SHUTDOWN_PERCENT,
  type BudgetFloor,
} from "../services/dual-agent/budget-floors.js";

describe("budgetFloor — level boundaries", () => {
  it("maps the documented thresholds (25 / 10 / 0) with the right edge semantics", () => {
    expect(budgetFloor(100)).toBe("none");
    expect(budgetFloor(BUDGET_LOW_PERCENT)).toBe("none");          // 25 is NOT low
    expect(budgetFloor(BUDGET_LOW_PERCENT - 1)).toBe("low");
    expect(budgetFloor(BUDGET_SPEAKER_SLEEP_PERCENT)).toBe("low");  // 10 is NOT board-only
    expect(budgetFloor(BUDGET_SPEAKER_SLEEP_PERCENT - 1)).toBe("board-only");
    expect(budgetFloor(1)).toBe("board-only");
    expect(budgetFloor(BUDGET_SHUTDOWN_PERCENT)).toBe("all-stop");  // 0 IS all-stop
    expect(budgetFloor(-5)).toBe("all-stop");
  });
});

describe("paidServiceAllowed — the ladder", () => {
  it("allows everything above the low band", () => {
    for (const s of PAID_SERVICES) expect(paidServiceAllowed(s, "none")).toBe(true);
  });

  it("low band only takes the Live Observer backend", () => {
    expect(paidServiceAllowed("observer-live", "low")).toBe(false);
    for (const s of PAID_SERVICES.filter(x => x !== "observer-live")) {
      expect(paidServiceAllowed(s, "low")).toBe(true);
    }
  });

  it("board-only additionally drops the Speaker but keeps the board, Monitor and STT", () => {
    expect(paidServiceAllowed("speaker", "board-only")).toBe(false);
    expect(paidServiceAllowed("observer-live", "board-only")).toBe(false);
    expect(paidServiceAllowed("observer", "board-only")).toBe(true);
    expect(paidServiceAllowed("board-manager", "board-only")).toBe(true);
    expect(paidServiceAllowed("monitor-heartbeat", "board-only")).toBe(true);
    expect(paidServiceAllowed("stt", "board-only")).toBe(true);
  });

  it("all-stop denies EVERY paid service — the hard floor", () => {
    for (const s of PAID_SERVICES) expect(paidServiceAllowed(s, "all-stop")).toBe(false);
  });

  it("is monotonic: nothing denied at a healthier level is allowed at a worse one", () => {
    const order: BudgetFloor[] = ["none", "low", "board-only", "all-stop"];
    for (let i = 1; i < order.length; i++) {
      for (const s of PAID_SERVICES) {
        if (!paidServiceAllowed(s, order[i - 1])) expect(paidServiceAllowed(s, order[i])).toBe(false);
      }
    }
  });
});

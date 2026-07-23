// ON-THE-CLOCK DORMANCY (view-distance-lod-tiers.md step 2) — pins the pure
// sleep-length policy the quest-host needs loop arms after a null decide
// (needDormDueIn), the exact piece quest-host wires. The regression pinned
// last: a body parked AWAY FROM HOME (a finished spoken errand, a fetch) must
// wake in time for the walk-home grace check that lives in the same decide
// slot — a sleep armed to the next meter crossing instead left the creature
// standing at its errand's endpoint for minutes ("went out and never came
// back", 2026-07-23).
import {
  hungerTemplate,
  energyTemplate,
  tidyTemplate,
  needDormDueIn,
  type NeedTemplate,
} from "@shared/world-engine/interaction/behavior/needs.js";

const CAP_S = 1.5; // quest-host NEED_DECIDE_CAP_S — the non-meter safety net

const meterMap = (levels: Record<string, number>) => (key: string) => levels[key] ?? 0;

describe("needDormDueIn — the null-decide sleep length", () => {
  it("all-meter set: sleeps exactly to the EARLIEST threshold crossing", () => {
    // hunger fires at 1.0, rising 0.01/s from 0.4 → 60s away;
    // energy same rate from 0.7 → 30s away. The earliest crossing wins.
    const templates = [hungerTemplate("food", 0.01), energyTemplate(0.01)];
    const meters = meterMap({ "hunger:food": 0.4, energy: 0.7 });
    expect(needDormDueIn(templates, meters, CAP_S)).toBeCloseTo(30, 5);
  });

  it("a meter already past its threshold clamps to an immediate wake, never negative", () => {
    const templates = [hungerTemplate("food", 0.01)];
    expect(needDormDueIn(templates, meterMap({ "hunger:food": 1.2 }), CAP_S)).toBe(0);
  });

  it("a non-meter drive in the set (stock/mess) bounds the sleep at the cap", () => {
    // tidy's mess drive has no closed-form timer — a loose prop can appear any
    // frame the epoch doesn't catch, so the safety net bounds the sleep even
    // when every meter crossing is far away.
    const templates = [hungerTemplate("food", 0.001), tidyTemplate()];
    const dueIn = needDormDueIn(templates, meterMap({ "hunger:food": 0 }), CAP_S);
    expect(dueIn).toBe(CAP_S);
  });

  it("no finite timer at all (zero-rate meters only) falls back to the cap", () => {
    const frozen: NeedTemplate = {
      ...hungerTemplate("food", 0.01),
      drive: { kind: "meter", rate: 0, threshold: 1 },
    };
    expect(needDormDueIn([frozen], meterMap({}), CAP_S)).toBe(CAP_S);
  });

  it("REGRESSION: a pending walk-home grace caps the sleep at its expiry", () => {
    // The errand-goer scenario: a commanded creature finished its trip across
    // town, its meters are freshly satisfied (next crossing ~100s away), and
    // 3s of the 10s home-idle grace have accrued. It must wake when the grace
    // expires (7s) so the walk-home check runs — not stand at the market until
    // hunger fires.
    const templates = [hungerTemplate("food", 0.01)];
    const meters = meterMap({ "hunger:food": 0 }); // crossing 100s away
    expect(needDormDueIn(templates, meters, CAP_S, 7)).toBe(7);
  });

  it("with no grace pending (the default), the meter timer stands", () => {
    const templates = [hungerTemplate("food", 0.01)];
    const meters = meterMap({ "hunger:food": 0 });
    expect(needDormDueIn(templates, meters, CAP_S)).toBeCloseTo(100, 5);
  });

  it("a grace expiring before the cap wins even against non-meter drives", () => {
    // Both bounds present: the sleep is the tightest of them.
    const templates = [tidyTemplate()];
    expect(needDormDueIn(templates, meterMap({}), CAP_S, 0.5)).toBe(0.5);
  });
});

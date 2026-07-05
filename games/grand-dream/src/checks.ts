/**
 * Live invariant checks for the routes lab. These re-assert, at runtime and
 * in the browser, the same guarantees the vitest suite covers — a visible
 * conscience while poking at scenarios by hand.
 */

import type { LabWorld } from "./boot";
import type { DualWorld } from "./dual";

export interface Check {
  label: string;
  ok: boolean;
  detail: string;
}

type MaybeDual = LabWorld & Partial<Pick<DualWorld, "settlementPop" | "settlementTotalPop" | "isResting" | "histfigCount" | "vitalLedger">>;

/** `injectedSinceLoad`: population added from OUTSIDE the composition
 *  layer after load (tri harvest foundings) — part of the ledger, not a
 *  leak. */
export function runChecks(lw: LabWorld, initialTotalPop: number, injectedSinceLoad: number = 0): Check[] {
  const checks: Check[] = [];
  const total = lw.totalPop();

  // The ledger identity: Σ pops + histfigs = start + births − deaths +
  // externally injected (harvest foundings). Migration, sheds, flips and
  // colonies only MOVE people; vitals and harvests account for the rest.
  const dual0 = lw as MaybeDual;
  const histfigs = dual0.histfigCount?.() ?? 0;
  const ledger = dual0.vitalLedger?.() ?? { births: 0, deaths: 0 };
  const expected = initialTotalPop + ledger.births - ledger.deaths + injectedSinceLoad;
  const migrates = lw.routes().some(r => r.migration > 0);
  const bits: string[] = [];
  if (histfigs > 0) bits.push(`+ ${histfigs} histfig${histfigs === 1 ? "" : "s"}`);
  if (ledger.births > 0 || ledger.deaths > 0) bits.push(`(+${ledger.births}/−${ledger.deaths} vital)`);
  if (injectedSinceLoad > 0) bits.push(`(+${injectedSinceLoad.toLocaleString()} founded)`);
  if (migrates) bits.push("(migration on)");
  checks.push({
    label: "Population ledger balanced",
    ok: total + histfigs === expected,
    detail: `${total.toLocaleString()} ${bits.join(" ")} vs expected ${expected.toLocaleString()}`,
  });

  // No site pop goes negative.
  const negative = lw.sites().find(s => s.pops.some(p => p.pop < 0));
  checks.push({
    label: "No negative populations",
    ok: !negative,
    detail: negative ? `site ${negative.key} has a negative subpopulation` : "all ≥ 0",
  });

  // Each site's summed subpops equals its tracked total.
  let mismatch: string | null = null;
  for (const s of lw.sites()) {
    const summed = s.pops.reduce((a, p) => a + p.pop, 0);
    if (summed !== s.pop) { mismatch = `${s.key}: Σpops ${summed} ≠ site.pop ${s.pop}`; break; }
  }
  checks.push({
    label: "Site totals consistent",
    ok: !mismatch,
    detail: mismatch ?? "Σ subpops = site.pop everywhere",
  });

  // Dual worlds only: the settlement layer's population values must equal
  // the composition layer's site totals EXACTLY after every step — the
  // integer write-back is the contract (unified-world-model.md §4).
  const dual = lw as MaybeDual;
  if (dual.settlementPop && dual.settlementTotalPop) {
    let disagree: string | null = null;
    for (const s of lw.sites()) {
      const composition = s.pops.reduce((a, p) => a + p.pop, 0);
      const settlement = dual.settlementPop(s.key);
      if (settlement !== composition) {
        disagree = `${s.key}: settlement ${settlement} ≠ composition ${composition}`;
        break;
      }
    }
    checks.push({
      label: "Layers agree",
      ok: !disagree,
      detail: disagree ?? `settlement pop = composition pop on every site (Σ ${dual.settlementTotalPop().toLocaleString()})`,
    });

    if (dual.isResting) {
      // Informational: when true, idle time would fast-forward in O(1).
      checks.push({
        label: dual.isResting() ? "World at rest" : "World active",
        ok: true,
        detail: dual.isResting()
          ? "both layers on a fixed point — idle days skip in O(1)"
          : "dynamics still running (rest detection watching)",
      });
    }
  }

  return checks;
}

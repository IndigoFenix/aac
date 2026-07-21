/**
 * Site focus — resolving a game's `initial_focus` against a settled
 * substrate's founding candidates. Shared by every substrate-backed scope
 * (planet, region): focus targets ARE the sites a town would be founded
 * on, whatever the lattice.
 *
 *   - `"site:<rank>"` — the Nth candidate in ranking order;
 *   - a parameter set `{ type?: "site", minDensity?, minOre?,
 *     minFertility? }` — the first (best-ranked) site whose crowd and
 *     radius-3 charter box meet every bound;
 *   - null — no focus: the whole world is the view.
 *
 * Generation always covered the whole scope; this only picks the frame.
 * Reject-never-skip: an unknown ID form, an unknown parameter, or a
 * parameter set nothing matches are all path-exact errors.
 */
import type { CellGrid } from "./grid";
import type { FoundingSite } from "./worldgen";

export interface SiteFocus {
  /** The focused substrate cell (the camera/spawn anchor). */
  cell: number;
  site: FoundingSite;
}

/** The `initial_focus` value as the manifest kernel hands it over. */
export type FocusRef = string | Record<string, unknown> | null;

function fail(path: string, msg: string): never {
  throw new Error(`${path}: ${msg}`);
}

function num(v: unknown, path: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) fail(path, `must be a number (${min}..${max})`);
  if (v < min || v > max) fail(path, `out of range (${min}..${max})`);
  return v;
}

/** Σ of a field over the radius-3 charter box of a cell. */
function focusBox(grid: CellGrid, field: string, cell: number): number {
  const arr = grid.fields[field];
  if (!arr) return 0;
  let sum = 0;
  grid.topo.disk(cell, 3, c => { sum += arr[c]; });
  return sum;
}

export function resolveSiteFocus(
  grid: CellGrid,
  sites: FoundingSite[],
  focus: FocusRef,
  label = "game",
): SiteFocus | null {
  if (focus === null) return null;
  const at = `${label}.initial_focus`;

  if (typeof focus === "string") {
    const m = /^site:(\d+)$/.exec(focus);
    if (!m) fail(at, `unknown object ID "${focus}" (site IDs: "site:<rank>")`);
    const rank = Number(m[1]);
    if (rank >= sites.length) {
      fail(at, `"${focus}" — this world settled only ${sites.length} founding sites`);
    }
    return { cell: sites[rank].cell, site: sites[rank] };
  }

  for (const k of Object.keys(focus)) {
    if (!["type", "minDensity", "minOre", "minFertility"].includes(k)) {
      fail(`${at}.${k}`, "unknown parameter (allowed: type, minDensity, minOre, minFertility)");
    }
  }
  if ("type" in focus && focus.type !== "site") {
    fail(`${at}.type`, `focus targets are founding sites (expected "site")`);
  }
  const minDensity = "minDensity" in focus ? num(focus.minDensity, `${at}.minDensity`, 0, 1e9) : 0;
  const minOre = "minOre" in focus ? num(focus.minOre, `${at}.minOre`, 0, 1e9) : 0;
  const minFertility = "minFertility" in focus ? num(focus.minFertility, `${at}.minFertility`, 0, 1e9) : 0;

  for (const site of sites) {
    if (site.density < minDensity) continue;
    if (minOre > 0 && focusBox(grid, "ore", site.cell) < minOre) continue;
    if (minFertility > 0 && focusBox(grid, "fertility", site.cell) < minFertility) continue;
    return { cell: site.cell, site };
  }
  fail(at, `no founding site matches (this world settled ${sites.length} candidates)`);
}

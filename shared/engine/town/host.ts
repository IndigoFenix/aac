/**
 * host.ts — the TOWN HOST seam: the narrow view of a world the town
 * layer reads. It is a STRUCTURAL SUBSET of grand-dream's TriWorld, so a
 * full four-layer world satisfies it without an adapter — and a
 * standalone TownWorld (town-world.ts) satisfies it without popusim.
 *
 * The town layer never receives the world's compiled economy through
 * this interface: content resolution (which registry, what fallback) is
 * the GAME's concern, so every entry point that needs the registry takes
 * it as an explicit parameter beside the host.
 */

/** A settlement's live books + map presence, as the town layer reads them. */
export interface TownHost {
  /** City sites (world tiles). Structurally a subset of richer city
   *  records — only key/position are read here. */
  cities: ReadonlyArray<{ key: string; x: number; y: number }>;
  /** The founding charter attrs the plan reads (biome, ground). */
  charterOf(siteKey: string): { farmland: number; ore_access: number };
  /** The substrate grid, for field bearings (typed growth bias). A
   *  host without a substrate leaves it undefined — towns lay out with
   *  unbiased arterials. */
  grid?: unknown;
  /** The settlement books. `settlementScalar` must read 0 for vars the
   *  world doesn't declare (the cell-systems contract). A host may also
   *  expose `routes()` (trade partners aim the arterials) and
   *  `entityWorld` (ledger presence checks) — both read structurally. */
  dual: { settlementScalar(siteKey: string, scalar: string): number };
}

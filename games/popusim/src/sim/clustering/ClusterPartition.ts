/**
 * Trait clustering — Phase C1: runtime partition + projection.
 *
 * Wraps the C0 detector output in a runtime structure that can PROJECT a full
 * syndrome (the trait set of a Population) onto each cluster, yielding the
 * per-cluster marginal sub-key. This is the substrate the factored
 * representation is built on: a unit's full syndrome = the tuple of its
 * per-cluster sub-keys.
 *
 * Living vs absorbed: a population is "absorbed" (dead / exited) when it is
 * missing a membership trait (e.g. `alive`). Absorbed units leave the living
 * clusters entirely — they are NOT projected as an empty state, because that
 * would (correctly) couple every living cluster through the dead state. The
 * living clusters factor over the LIVING population only. This is the
 * "separate absorbed population" rule from clustering-design.md §3.
 *
 * Phase C1 is still diagnostics-only: the partition is used by the shadow
 * verifier (ClusterVerifier) to confirm the live joint distribution actually
 * factors along the detected partition. No simulation behavior changes.
 */

import { detectClusters, type ClusterReport } from './ClusterDetector';

export interface RuntimeCluster {
	id: number;
	traitKeys: Set<string>;
	size: number;
}

export interface Projection {
	absorbed: boolean;
	/** Per-cluster sub-key (sorted trait subset joined by '|'); index aligns
	 * with `partition.clusters`. Empty/`''` means "no trait of this cluster".
	 * Undefined when `absorbed` is true. */
	subkeys?: string[];
}

export class ClusterPartition {
	readonly clusters: RuntimeCluster[];
	readonly membership: string[];
	readonly report: ClusterReport;

	/**
	 * @param baseKeys  if given, the partition is restricted to these (base,
	 *   non-combo) traits. Combo / correlation traits are derived VIEWS of base
	 *   traits (e.g. `not_infected = def_not infected`); they appear in syndromes
	 *   but are perfectly determined by the base set, so they are not independent
	 *   factorable state and must be excluded from the factored representation.
	 */
	constructor(report: ClusterReport, baseKeys?: Set<string>) {
		this.report = report;
		const filt = (keys: string[]): string[] => baseKeys ? keys.filter(k => baseKeys.has(k)) : keys;
		this.clusters = report.clusters
			.map(filt)
			.filter(c => c.length > 0)
			.map((c, i) => ({ id: i, traitKeys: new Set(c), size: c.length }));
		this.membership = filt(report.membership);
	}

	/** Number of clusters with >1 trait (the genuinely-joint factors). */
	get multiClusterCount(): number {
		return this.clusters.reduce((n, c) => n + (c.size > 1 ? 1 : 0), 0);
	}

	/** Project a syndrome's trait keys onto the partition. */
	project(traitKeys: string[]): Projection {
		// Absorbed if missing any membership trait. With no membership traits we
		// cannot identify the living set, so treat everything as living (and the
		// verifier will surface any resulting exit-correlation as residual).
		if (this.membership.length > 0) {
			for (const m of this.membership) {
				if (!traitKeys.includes(m)) return { absorbed: true };
			}
		}
		const has = new Set(traitKeys);
		const subkeys = this.clusters.map(c => {
			const sub: string[] = [];
			for (const k of c.traitKeys) if (has.has(k)) sub.push(k);
			sub.sort();
			return sub.join('|');
		});
		return { absorbed: false, subkeys };
	}
}

/** Build the runtime partition from a started World. Clusters over base
 * (non-combo) traits only — combo traits are derived views, not factorable
 * state. */
export function buildPartition(
	world: { traits: { key: string; is_combo?: boolean }[]; vectors: unknown[]; sites: unknown[] },
	opts: { resourceValues?: Record<string, number>; band?: number } = {},
): ClusterPartition {
	const baseKeys = new Set<string>();
	for (const t of world.traits) if (!t.is_combo) baseKeys.add(t.key);
	return new ClusterPartition(detectClusters(world as never, opts), baseKeys);
}

/**
 * Trait clustering — Phase C1: shadow verifier.
 *
 * Projects the live joint populations onto the detected partition and checks
 * that the joint distribution actually FACTORS along it:
 *   predicted(s) = livingN · Π_c marginal_c(proj_c(s)) / livingN
 *   residual     = max_s |actual(s) − predicted(s)| / livingN
 *
 * If the C0 criterion is correct, residual is ~0 (within sampling noise) on any
 * scenario whose detected clusters are genuinely independent. A large residual
 * means the static detector missed a coupling — i.e. it's the runtime
 * edge-case net for the whole clustering theory.
 *
 * It also measures the would-be storage saving: `jointPops` (distinct living
 * populations tracked today) vs `factoredStates` (Σ realized marginal states
 * across clusters). When factoredStates ≥ jointPops the scenario does not
 * benefit from factoring (e.g. COVID, one entangled blob) — a useful signal.
 *
 * This is pure measurement: it reads population counts and mutates nothing.
 */

import type { ClusterPartition } from './ClusterPartition';

interface PopLike { pop: number; syndrome: { trait_keys: string[] }; }
interface SiteLike { key: string; pops: PopLike[]; }
interface WorldLike { sites: SiteLike[]; }

export interface SiteVerification {
	siteKey: string;
	livingN: number;
	absorbedN: number;
	jointPops: number;       // distinct living populations
	factoredStates: number;  // Σ realized marginal states across clusters
	residual: number;        // max |actual − predicted| / livingN
}

export interface FactorVerification {
	sites: SiteVerification[];
	maxResidual: number;
	jointPopsTotal: number;
	factoredStatesTotal: number;
	/** factoredStatesTotal / jointPopsTotal — < 1 means factoring saves. */
	costRatio: number;
}

export function verifyFactorization(world: WorldLike, partition: ClusterPartition): FactorVerification {
	const sites: SiteVerification[] = [];

	for (const site of world.sites) {
		// living populations only; absorbed (dead/exited) tracked separately
		const living: { sub: string[]; count: number }[] = [];
		let livingN = 0, absorbedN = 0;
		for (const p of site.pops) {
			if (p.pop <= 0) continue;
			const proj = partition.project(p.syndrome.trait_keys);
			if (proj.absorbed) { absorbedN += p.pop; continue; }
			living.push({ sub: proj.subkeys!, count: p.pop });
			livingN += p.pop;
		}

		// per-cluster marginals over the living population
		const marginals: Map<string, number>[] = partition.clusters.map(() => new Map());
		for (const { sub, count } of living) {
			for (let c = 0; c < marginals.length; c++) {
				const key = sub[c];
				marginals[c].set(key, (marginals[c].get(key) ?? 0) + count);
			}
		}

		// residual: compare each actual living pop to the product prediction
		let residual = 0;
		if (livingN > 0) {
			for (const { sub, count } of living) {
				let predicted = livingN;
				for (let c = 0; c < marginals.length; c++) {
					predicted *= (marginals[c].get(sub[c]) ?? 0) / livingN;
				}
				const dev = Math.abs(count - predicted) / livingN;
				if (dev > residual) residual = dev;
			}
		}

		const factoredStates = marginals.reduce((n, m) => n + m.size, 0);
		sites.push({
			siteKey: site.key,
			livingN, absorbedN,
			jointPops: living.length,
			factoredStates,
			residual,
		});
	}

	const maxResidual = sites.reduce((m, s) => Math.max(m, s.residual), 0);
	const jointPopsTotal = sites.reduce((n, s) => n + s.jointPops, 0);
	const factoredStatesTotal = sites.reduce((n, s) => n + s.factoredStates, 0);
	return {
		sites,
		maxResidual,
		jointPopsTotal,
		factoredStatesTotal,
		costRatio: jointPopsTotal > 0 ? factoredStatesTotal / jointPopsTotal : 1,
	};
}

/** Per-cluster living marginals computed from a joint World's populations. */
export function clusterMarginalsFromJoint(world: WorldLike, partition: ClusterPartition): Map<number, Map<string, number>> {
	const out = new Map<number, Map<string, number>>();
	for (const c of partition.clusters) out.set(c.id, new Map());
	for (const site of world.sites) {
		for (const p of site.pops) {
			if (p.pop <= 0) continue;
			const proj = partition.project(p.syndrome.trait_keys);
			if (proj.absorbed) continue;
			proj.subkeys!.forEach((sk, i) => {
				const m = out.get(partition.clusters[i].id)!;
				m.set(sk, (m.get(sk) ?? 0) + p.pop);
			});
		}
	}
	return out;
}

interface EvolverLike { clusterMarginal(id: number): Map<string, number>; }

/**
 * Max relative per-cluster marginal divergence between the factored evolver and
 * the joint World, normalized by the joint living total. The promotion gate
 * (C2-final) compares this against a threshold over a warmup window before the
 * evolver is trusted to run alone.
 */
export function evolverJointResidual(evolver: EvolverLike, world: WorldLike, partition: ClusterPartition): number {
	const jm = clusterMarginalsFromJoint(world, partition);
	let living = 0;
	for (const v of (jm.get(partition.clusters[0]?.id ?? -1) ?? new Map<string, number>()).values()) living += v;
	if (living <= 0) return 0;
	let worst = 0;
	for (const c of partition.clusters) {
		const a = jm.get(c.id)!, b = evolver.clusterMarginal(c.id);
		for (const k of new Set([...a.keys(), ...b.keys()])) {
			worst = Math.max(worst, Math.abs((a.get(k) ?? 0) - (b.get(k) ?? 0)) / living);
		}
	}
	return worst;
}

/**
 * Trait clustering — Phase C2a: the factored evolver.
 *
 * Holds one small sub-World per cluster (built via `projectScenarioToCluster`)
 * and steps them in lockstep. Each sub-World runs the REAL engine on just its
 * cluster's traits + marginal populations, so no dynamics are re-implemented —
 * the engine's modifier/seek/infection math is reused verbatim.
 *
 * Scope (C2a): independent, coupling-free clusters under the supported feature
 * set (transmit / progress / infection / within-cluster mixing). Each sub-World
 * partitions the SAME N people into that cluster's states. With no cross-cluster
 * coupling the sub-Worlds evolve independently and their marginals reproduce the
 * joint engine's marginals (proven in factoredEvolver.test.ts under sd=0).
 *
 * Cross-cluster full-strip removal (C2b — death / emigration) IS handled: when a
 * unit loses a membership trait it leaves every cluster at once. Because such
 * removal is uniform w.r.t. the independent clusters (a removal whose rate
 * depends jointly on two clusters forces those clusters to MERGE, so the glue
 * only ever sees uniform exits), follower clusters' *distributions* stay correct
 * even though their *totals* drift. So we don't mutate sub-World state: we read
 * the true living total from whichever cluster owns the exit dynamics and scale
 * every cluster's marginal to it at read time. Data-RETAINING spanning traits
 * (e.g. `hospitalized`) are NOT removals — they keep the unit alive and are
 * handled by the detector (merge if they span, within-cluster otherwise).
 *
 * Shared stockpiles (C2c) are still not handled.
 */

import '../../wireup';
import { System } from '../../controller/System';
import { World } from '../../controller/World';
import { projectScenarioToCluster } from './scenarioProjection';
import type { ClusterPartition } from './ClusterPartition';

interface SubWorld {
	clusterId: number;
	traitKeys: Set<string>;
	world: World;
}

interface PopLike { pop: number; syndrome: { trait_keys: string[] }; }
interface SiteLike { pops: PopLike[]; }
interface StockpileLike { resource: { key: string }; value: number; setValue(v: number): void; }

export class FactoredEvolver {
	private subs: SubWorld[] = [];
	readonly membership: string[];
	/** True when the partition's removal bundle touches independent clusters
	 * (full-strip death/emigration). Informational — the evolver now handles it
	 * via the read-time living-total glue (C2b). */
	readonly hasExitCoupling: boolean;
	/** Original total population (= all living on day 0, identical across every
	 * cluster sub-World). Captured after build. */
	private totalN = 0;
	/** Cluster ids that OWN a membership-changing trait rule (a transmit/progress
	 * that adds or removes a membership trait — trait-owned birth or death). Such
	 * clusters' living mass deviates from the shared baseline; followers don't.
	 * Site-level immigration is replicated into every sub-World, so it makes no
	 * cluster an owner — all sub-Worlds reflect it equally. */
	private ownerClusterIds: Set<number> = new Set();
	/** Non-membership base traits whose rules add/remove a membership trait
	 * (trait-owned birth/death). A sub-World owns a removal iff its traits
	 * intersect this set — used to recompute owners after a re-partition. */
	private membershipChangers: Set<string> = new Set();
	/** Last reconciled shared value per stockpile (resource key). The C2c
	 * aggregate-coupling channel: a resource produced in one cluster and read as
	 * a modifier in another lives in every sub-World, and the true value is the
	 * baseline plus each sub-World's local net (production − consumption). */
	private sharedStockpiles: Map<string, number> = new Map();

	private scenario: Record<string, unknown> = {};
	private seed: number = 0;
	/** Monotonic id for sub-Worlds created by re-partition (C3). */
	private nextClusterId: number = 0;

	private constructor(
		private readonly partition: ClusterPartition,
		exitTraits: Set<string>,
	) {
		this.membership = partition.membership;
		this.hasExitCoupling = partition.clusters.some(c => [...c.traitKeys].some(k => exitTraits.has(k)));
	}

	/** Build (and start) one sub-World per cluster from the raw scenario JSON. */
	static async build(
		scenario: Record<string, unknown>,
		partition: ClusterPartition,
		seed: number,
	): Promise<FactoredEvolver> {
		const ev = new FactoredEvolver(partition, new Set(partition.report.exitTraits));
		ev.scenario = scenario;
		ev.seed = seed;
		ev.nextClusterId = Math.max(0, ...partition.clusters.map(c => c.id)) + 1;
		for (const cluster of partition.clusters) {
			ev.subs.push(await ev.makeSubWorld(cluster.traitKeys, cluster.id));
		}
		// day-0 living total — identical across every sub-World (all partition
		// the same people, none dead yet)
		ev.totalN = Math.max(0, ...ev.subs.map(s => ev.rawLivingMass(s)));
		ev.membershipChangers = computeMembershipChangers(scenario, ev.membership);
		ev.recomputeOwners();
		// capture day-0 shared stockpile values (identical across sub-Worlds)
		for (const sp of ev.stockpilesOf(ev.subs[0])) ev.sharedStockpiles.set(sp.resource.key, sp.value);
		return ev;
	}

	private subOwnsRemoval(traitKeys: Set<string>): boolean {
		for (const k of traitKeys) if (this.membershipChangers.has(k)) return true;
		return false;
	}
	private recomputeOwners(): void {
		this.ownerClusterIds = new Set(this.subs.filter(s => this.subOwnsRemoval(s.traitKeys)).map(s => s.clusterId));
	}

	/** Project + start one sub-World over `traitKeys`, optionally from a custom
	 * startpop (C3 re-partition seeds the new sub-World from current state). */
	private async makeSubWorld(traitKeys: Set<string>, clusterId: number, startpop?: { size: number; apply: string }[]): Promise<SubWorld> {
		const sub = projectScenarioToCluster(this.scenario, traitKeys, this.membership, clusterId, startpop);
		const system = new System(null);
		system.rand.seed(this.seed + clusterId * 7919 + 1);
		(system as unknown as { renderIfNeeded: () => void }).renderIfNeeded = () => { };
		const world = new World(system as never, sub.scenario);
		(system as unknown as { world: World }).world = world;
		await world.start();
		// new sub-World starts at the shared stockpile values, not the scenario defaults
		for (const sp of (world as unknown as { all_stockpiles?: StockpileLike[] }).all_stockpiles ?? []) {
			const v = this.sharedStockpiles.get(sp.resource.key);
			if (v !== undefined && sp.value !== v) sp.setValue(v);
		}
		return { clusterId, traitKeys, world };
	}

	private stockpilesOf(sub: SubWorld): StockpileLike[] {
		return (sub.world as unknown as { all_stockpiles?: StockpileLike[] }).all_stockpiles ?? [];
	}

	/** Advance every sub-World by one day, then reconcile shared stockpiles. */
	async step(): Promise<void> {
		for (const s of this.subs) await (s.world as unknown as { newDay(): Promise<void> }).newDay();
		this.reconcileStockpiles();
	}

	/**
	 * Reconcile resources shared across sub-Worlds (C2c). Each sub-World ran the
	 * day starting from the shared value and applied only ITS cluster's
	 * production/consumption, so its local value deviates from the baseline by its
	 * own net. The true value is baseline + Σ deviations; write it back to every
	 * sub-World for the next day. A reader in another cluster therefore sees the
	 * aggregate with a one-day lag — consistent with the daily lock-in model.
	 * (Abundant-supply assumption: no per-day rationing under scarcity yet.)
	 */
	private reconcileStockpiles(): void {
		for (const [key, prev] of this.sharedStockpiles) {
			let total = prev;
			const stocks: StockpileLike[] = [];
			for (const sub of this.subs) {
				const sp = this.stockpilesOf(sub).find(s => s.resource.key === key);
				if (sp) { total += sp.value - prev; stocks.push(sp); }
			}
			for (const sp of stocks) if (sp.value !== total) sp.setValue(total);
			this.sharedStockpiles.set(key, total);
		}
	}

	/** Current reconciled value of a shared resource (diagnostics / tests). */
	sharedStockpileValue(resourceKey: string): number | undefined {
		return this.sharedStockpiles.get(resourceKey);
	}

	/** Force a shared resource value across all sub-Worlds (e.g. an external
	 * policy/event input that gates a coupling). */
	setSharedStockpile(resourceKey: string, value: number): void {
		this.sharedStockpiles.set(resourceKey, value);
		for (const sub of this.subs) {
			const sp = this.stockpilesOf(sub).find(s => s.resource.key === resourceKey);
			if (sp && sp.value !== value) sp.setValue(value);
		}
	}

	/** Raw living mass in a sub-World (units carrying every membership trait),
	 * UNSCALED — i.e. before the cross-cluster removal correction. A cluster that
	 * owns death dynamics shrinks; a follower stays at totalN. */
	private rawLivingMass(sub: SubWorld): number {
		let n = 0;
		const sites = (sub.world as unknown as { sites: SiteLike[] }).sites;
		for (const site of sites) for (const p of site.pops) {
			if (p.pop <= 0) continue;
			if (this.membership.some(mk => !p.syndrome.trait_keys.includes(mk))) continue;
			n += p.pop;
		}
		return n;
	}

	/**
	 * The true living total, reconciled across sub-Worlds. Every sub-World shares
	 * a baseline B = totalN + net REPLICATED change (site-level immigration that
	 * appears in all sub-Worlds). Each OWNER cluster additionally carries its own
	 * trait-owned births (growth) or deaths (shrink) as a deviation from B;
	 * followers sit exactly at B. So `trueLivingN = B + Σ_owner (rawMass − B)`,
	 * which handles uniform death, multi-source death, and replicated immigration.
	 * (Trait-rate-driven birth needs the C2c aggregate channel for follower
	 * distributions; its total is already correct here.)
	 */
	trueLivingN(): number {
		const followers = this.subs.filter(s => !this.ownerClusterIds.has(s.clusterId));
		const baseline = followers.length > 0 ? this.rawLivingMass(followers[0]) : this.totalN;
		let total = baseline;
		for (const s of this.subs) {
			if (this.ownerClusterIds.has(s.clusterId)) total += this.rawLivingMass(s) - baseline;
		}
		return Math.max(0, total);
	}

	/** Marginal distribution of one cluster: Map<subkey, count> over the
	 * cluster's traits (membership excluded). Scaled to the true living total so
	 * follower clusters that didn't see the deaths report correct absolute
	 * counts (C2b). */
	clusterMarginal(clusterId: number): Map<string, number> {
		const sub = this.subs.find(s => s.clusterId === clusterId);
		const m = new Map<string, number>();
		if (!sub) return m;
		const sites = (sub.world as unknown as { sites: SiteLike[] }).sites;
		let raw = 0;
		for (const site of sites) {
			for (const p of site.pops) {
				if (p.pop <= 0) continue;
				if (this.membership.some(mk => !p.syndrome.trait_keys.includes(mk))) continue;
				const subkey = p.syndrome.trait_keys.filter(k => sub.traitKeys.has(k)).sort().join('|');
				m.set(subkey, (m.get(subkey) ?? 0) + p.pop);
				raw += p.pop;
			}
		}
		// scale this cluster's (uniform) distribution to the true living total
		const scale = raw > 0 ? this.trueLivingN() / raw : 0;
		if (scale !== 1) for (const [k, v] of m) m.set(k, v * scale);
		return m;
	}

	/** All cluster marginals, keyed by clusterId. */
	allMarginals(): Map<number, Map<string, number>> {
		const out = new Map<number, Map<string, number>>();
		for (const s of this.subs) out.set(s.clusterId, this.clusterMarginal(s.clusterId));
		return out;
	}

	// ---- authoritative outputs (C2-final): read results from marginals, no joint

	/** Living count of a single base trait. Membership traits → all living. */
	traitLivingCount(key: string): number {
		if (this.membership.includes(key)) return this.trueLivingN();
		const sub = this.subs.find(s => s.traitKeys.has(key));
		if (!sub) return 0; // combo/derived trait, or absent
		let n = 0;
		for (const [subkey, count] of this.clusterMarginal(sub.clusterId)) {
			if (subkey.split('|').includes(key)) n += count;
		}
		return n;
	}

	/**
	 * Reconstructed joint count of a specific LIVING syndrome = trueLivingN ·
	 * Π_cluster P(cluster-projection). This is how a cross-cluster combo (what a
	 * correlation tracker reads) is recovered from the factored marginals without
	 * ever materializing the full product.
	 */
	syndromeCount(traitKeys: string[]): number {
		const keySet = new Set(traitKeys);
		if (this.membership.some(mk => !keySet.has(mk))) return 0; // not a living syndrome
		const tln = this.trueLivingN();
		if (tln <= 0) return 0;
		let prob = 1;
		for (const s of this.subs) {
			const projected = [...s.traitKeys].filter(k => keySet.has(k)).sort().join('|');
			prob *= (this.clusterMarginal(s.clusterId).get(projected) ?? 0) / tln;
		}
		return tln * prob;
	}

	/**
	 * Living count of people having ALL of `traitKeys` (a partial cross-cluster
	 * query — what a correlation tracker reads). Unmentioned clusters are
	 * marginalized; within each mentioned cluster we sum the subkeys that contain
	 * the wanted traits. When the wanted traits span a single (merged) cluster
	 * this returns the true joint (correlated) count; when they're in separate
	 * (split) clusters it returns the product — exactly the right thing in both
	 * regimes, so a split that happened only after decorrelation reads correctly.
	 */
	combinedCount(traitKeys: string[]): number {
		const want = traitKeys.filter(k => !this.membership.includes(k));
		const tln = this.trueLivingN();
		if (tln <= 0) return 0;
		let prob = 1;
		for (const s of this.subs) {
			const wantedHere = want.filter(k => s.traitKeys.has(k));
			if (wantedHere.length === 0) continue; // cluster not constrained → factor 1
			let sum = 0;
			for (const [subkey, c] of this.clusterMarginal(s.clusterId)) {
				const parts = subkey.split('|');
				if (wantedHere.every(k => parts.includes(k))) sum += c;
			}
			prob *= sum / tln;
		}
		return tln * prob;
	}

	/** All shared resource values (resourceKey → value). */
	resourceValues(): Map<string, number> {
		return new Map(this.sharedStockpiles);
	}

	/**
	 * Max relative error between the evolver's reconstructed living populations
	 * and a joint World's actual ones — `max |jointPop − syndromeCount(syndrome)|
	 * / livingN`. Partition-INDEPENDENT (syndromeCount works whatever the current
	 * sub-World grouping is) and correlation-aware (if the evolver wrongly kept a
	 * correlated pair split, its product reconstruction mismatches the joint).
	 * This is the promotion gate's check under dynamic re-partition.
	 */
	reconstructionResidual(sites: { pops: PopLike[] }[]): number {
		let livingN = 0;
		const living: PopLike[] = [];
		for (const site of sites) for (const p of site.pops) {
			if (p.pop <= 0) continue;
			if (this.membership.some(m => !p.syndrome.trait_keys.includes(m))) continue; // absorbed
			living.push(p);
			livingN += p.pop;
		}
		if (livingN <= 0) return 0;
		let worst = 0;
		for (const p of living) worst = Math.max(worst, Math.abs(p.pop - this.syndromeCount(p.syndrome.trait_keys)) / livingN);
		return worst;
	}

	/** Living population a cluster reports (after the C2b scaling) — equals
	 * trueLivingN for every cluster. */
	clusterLivingN(clusterId: number): number {
		let n = 0;
		for (const v of this.clusterMarginal(clusterId).values()) n += v;
		return n;
	}

	get clusterIds(): number[] { return this.subs.map(s => s.clusterId); }

	// ---- C3: dynamic merge / split ------------------------------------------

	private splitTraits(subkey: string): string[] { return subkey.split('|').filter(Boolean); }

	/** Merge a set of current sub-Worlds into one, initialized from the OUTER
	 * PRODUCT of their marginals (exact, since they were independent until now).
	 * Always safe. */
	private async merge(group: SubWorld[]): Promise<void> {
		if (group.length < 2) return;
		const tln = this.trueLivingN();
		const margs = group.map(s => this.clusterMarginal(s.clusterId));
		let combos: { traits: string[]; size: number }[] = [{ traits: [], size: tln }];
		for (const m of margs) {
			const next: { traits: string[]; size: number }[] = [];
			for (const c of combos) for (const [subkey, count] of m) {
				next.push({ traits: [...c.traits, ...this.splitTraits(subkey)], size: tln > 0 ? c.size * (count / tln) : 0 });
			}
			combos = next;
		}
		const startpop = combos.filter(c => c.size > 0).map(c => ({ size: c.size, apply: [...new Set([...c.traits, ...this.membership])].join(',') }));
		startpop.push({ size: Math.max(0, this.totalN - tln), apply: '' });
		const newTraits = new Set<string>();
		for (const s of group) for (const k of s.traitKeys) newTraits.add(k);
		const merged = await this.makeSubWorld(newTraits, this.nextClusterId++, startpop);
		this.subs = this.subs.filter(s => !group.includes(s));
		this.subs.push(merged);
		this.recomputeOwners();
	}

	/** Max factorization residual of a sub-World's joint along `groups`. */
	private factorResidual(sub: SubWorld, groups: Set<string>[]): number {
		const m = this.clusterMarginal(sub.clusterId);
		const tln = this.trueLivingN();
		if (tln <= 0) return 0;
		const gm = groups.map(() => new Map<string, number>());
		for (const [subkey, c] of m) {
			const parts = this.splitTraits(subkey);
			groups.forEach((g, i) => { const gk = parts.filter(k => g.has(k)).sort().join('|'); gm[i].set(gk, (gm[i].get(gk) ?? 0) + c); });
		}
		let worst = 0;
		for (const [subkey, c] of m) {
			const parts = this.splitTraits(subkey);
			let pred = tln;
			groups.forEach((g, i) => { const gk = parts.filter(k => g.has(k)).sort().join('|'); pred *= (gm[i].get(gk) ?? 0) / tln; });
			worst = Math.max(worst, Math.abs(c - pred) / tln);
		}
		return worst;
	}

	/** Split a sub-World into `groups` — ONLY if its joint factors (Gate 2). */
	private async trySplit(sub: SubWorld, groups: Set<string>[], eps: number): Promise<boolean> {
		if (this.factorResidual(sub, groups) > eps) return false;
		const m = this.clusterMarginal(sub.clusterId);
		const tln = this.trueLivingN();
		const made: SubWorld[] = [];
		for (const g of groups) {
			const gm = new Map<string, number>();
			for (const [subkey, c] of m) {
				const gk = this.splitTraits(subkey).filter(k => g.has(k)).sort().join('|');
				gm.set(gk, (gm.get(gk) ?? 0) + c);
			}
			const startpop = [...gm].filter(([, c]) => c > 0).map(([k, c]) => ({ size: c, apply: [...new Set([...this.splitTraits(k), ...this.membership])].join(',') }));
			startpop.push({ size: Math.max(0, this.totalN - tln), apply: '' });
			made.push(await this.makeSubWorld(g, this.nextClusterId++, startpop));
		}
		this.subs = this.subs.filter(s => s !== sub);
		this.subs.push(...made);
		this.recomputeOwners();
		return true;
	}

	/**
	 * Reconcile the sub-World partition to `targetGroups` (the ACTIVE-edge
	 * partition for the current resource values). MERGE eagerly (a sub spanning
	 * multiple targets... no — a target covering multiple subs); SPLIT a sub that
	 * spans multiple targets only when its joint factors (Gate 2). Membership-only
	 * sub-Worlds are left alone. Returns counts of operations performed.
	 */
	async repartition(targetGroups: string[][], splitEps: number = 1e-3): Promise<{ merges: number; splits: number }> {
		const targets = targetGroups.map(g => new Set(g.filter(k => !this.membership.includes(k)))).filter(g => g.size > 0);
		let merges = 0, splits = 0;
		// SPLIT first: a sub whose non-membership traits land in >1 target
		for (const sub of [...this.subs]) {
			const nonMem = [...sub.traitKeys].filter(k => !this.membership.includes(k));
			if (nonMem.length === 0) continue;
			const hit = targets.filter(g => nonMem.some(k => g.has(k)));
			if (hit.length > 1) {
				const groups = hit.map(g => new Set([...sub.traitKeys].filter(k => g.has(k))));
				if (await this.trySplit(sub, groups, splitEps)) splits++;
			}
		}
		// MERGE: a target covering >1 current sub
		for (const g of targets) {
			const members = this.subs.filter(sub => [...sub.traitKeys].some(k => g.has(k)));
			if (members.length > 1) { await this.merge(members); merges++; }
		}
		return { merges, splits };
	}

	/** Current sub-World groupings (non-membership trait sets) — diagnostics. */
	currentGroups(): string[][] {
		return this.subs.map(s => [...s.traitKeys].filter(k => !this.membership.includes(k))).filter(g => g.length > 0);
	}

	destroy(): void {
		for (const s of this.subs) {
			try { (s.world as unknown as { destroy?: () => void }).destroy?.(); } catch { /* ignore */ }
		}
		this.subs = [];
	}
}

/** Non-membership base traits whose transmit/progress adds or removes a
 * membership trait (trait-owned birth/death). Rules on a membership trait are
 * REPLICATED into every sub-World, so they are excluded — they create no
 * deviation to reconcile. */
function computeMembershipChangers(
	scenario: Record<string, unknown>,
	membership: string[],
): Set<string> {
	const mem = new Set(membership);
	const splitKeys = (v: unknown): string[] =>
		v === undefined || v === null ? []
			: Array.isArray(v) ? v.flatMap(splitKeys)
				: String(v).split(',').map(s => s.trim()).filter(Boolean);
	const out = new Set<string>();
	for (const t of (scenario.trait as Record<string, unknown>[] | undefined ?? [])) {
		const key = String(t.key);
		if (mem.has(key)) continue;
		const rules = [
			...(t.transmit as Record<string, unknown>[] | undefined ?? []),
			...(t.progress as Record<string, unknown>[] | undefined ?? []),
		];
		if (rules.some(r => splitKeys(r.apply).some(a => mem.has(a)) || splitKeys(r.remove).some(a => mem.has(a)))) {
			out.add(key);
		}
	}
	return out;
}

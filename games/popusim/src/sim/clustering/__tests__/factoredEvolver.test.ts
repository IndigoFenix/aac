/**
 * Phase C2a — dual-track equivalence.
 *
 * Under deterministic (sd=0) rates and an independent (coupling-free) partition,
 * the factored evolver's per-cluster marginals must reproduce the joint engine's
 * marginals day by day. This proves the per-cluster sub-World evolution is a
 * faithful, lossless substitute for joint tracking on the supported scenario
 * class — the correctness gate before the joint can be dropped.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import '../../../wireup';
import { System } from '../../../controller/System';
import { World } from '../../../controller/World';
import { buildPartition, type ClusterPartition } from '../ClusterPartition';
import { FactoredEvolver } from '../FactoredEvolver';
import { WorkerSim } from '../../workerSim';
import type { ClientMsg, WorkerMsg } from '../../protocol';

beforeAll(() => {
	if (!document.getElementById('wrapper')) {
		const wrapper = document.createElement('div');
		wrapper.id = 'wrapper';
		document.body.appendChild(wrapper);
	}
});

// independent disease (SIR, NO death) × politics × economics, deterministic.
function scenario(): Record<string, unknown> {
	return {
		name: 'C2a dual-track', use_date: false,
		phase: [{ key: 'spread' }, { key: 'progress' }],
		vector: [{ key: 'air', seek: [{ not_trait: 'alive', mult: 0 }] }, { key: 'recovery' }, { key: 'pol' }, { key: 'eco' }],
		trait: [
			{ key: 'alive' },
			{
				key: 'infected',
				transmit: [{ apply: 'infected', vector: 'air', value: 0.3, sd: 0, phase: 'spread' }],
				progress: [{ apply: 'immune', remove: 'infected', vector: 'recovery', value: 0.12, sd: 0, phase: 'progress' }],
			},
			{ key: 'immune' },
			{ key: 'support', progress: [{ apply: 'oppose', remove: 'support', vector: 'pol', value: 0.06, sd: 0, phase: 'progress' }] },
			{ key: 'oppose', progress: [{ apply: 'support', remove: 'oppose', vector: 'pol', value: 0.06, sd: 0, phase: 'progress' }] },
			{ key: 'employed', progress: [{ apply: 'unemployed', remove: 'employed', vector: 'eco', value: 0.05, sd: 0, phase: 'progress' }] },
			{ key: 'unemployed', progress: [{ apply: 'employed', remove: 'unemployed', vector: 'eco', value: 0.05, sd: 0, phase: 'progress' }] },
		],
		site: [{
			key: 'city', pop: 1_000_000,
			startpop: [
				{ size: 30, apply: 'alive,support,employed' },
				{ size: 30, apply: 'alive,support,unemployed' },
				{ size: 20, apply: 'alive,oppose,employed' },
				{ size: 20, apply: 'alive,oppose,unemployed' },
			],
			transmit: [{ apply: 'infected', vector: 'air', value: 50000, sd: 0, phase: 'spread' }],
		}],
	};
}

// joint engine's marginal for a cluster: bucket living joint pops by projection
function jointMarginals(world: World, partition: ClusterPartition): Map<number, Map<string, number>> {
	const out = new Map<number, Map<string, number>>();
	for (const c of partition.clusters) out.set(c.id, new Map());
	const sites = (world as unknown as { sites: { pops: { pop: number; syndrome: { trait_keys: string[] } }[] }[] }).sites;
	for (const site of sites) {
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

function maxMarginalDiff(a: Map<string, number>, b: Map<string, number>): number {
	let mx = 0;
	for (const k of new Set([...a.keys(), ...b.keys()])) mx = Math.max(mx, Math.abs((a.get(k) ?? 0) - (b.get(k) ?? 0)));
	return mx;
}

describe('FactoredEvolver — dual-track vs joint engine (sd=0)', () => {
	it('per-cluster marginals track the joint engine day by day', async () => {
		const SEED = 4242, DAYS = 20, N = 1_000_000;

		// joint engine
		const sysJ = new System(null);
		sysJ.rand.seed(SEED);
		(sysJ as unknown as { renderIfNeeded: () => void }).renderIfNeeded = () => { };
		const joint = new World(sysJ as never, scenario());
		(sysJ as unknown as { world: World }).world = joint;
		await joint.start();
		const partition = buildPartition(joint as never);

		// the scenario has no death/exit, so the evolver is fully authoritative
		const evolver = await FactoredEvolver.build(scenario(), partition, SEED);
		expect(evolver.hasExitCoupling).toBe(false);
		// disease / politics / economics are independent multi-trait clusters
		expect(partition.multiClusterCount).toBeGreaterThanOrEqual(3);

		let worstRel = 0;
		for (let day = 0; day < DAYS; day++) {
			await joint.newDay();
			await evolver.step();

			const jm = jointMarginals(joint, partition);
			for (const c of partition.clusters) {
				const diff = maxMarginalDiff(jm.get(c.id)!, evolver.clusterMarginal(c.id));
				worstRel = Math.max(worstRel, diff / N);
			}
			// every cluster sub-World conserves the full population
			for (const id of evolver.clusterIds) expect(evolver.clusterLivingN(id)).toBeCloseTo(N, 0);
		}

		console.log(`[C2a] worst per-cluster marginal divergence over ${DAYS} days: ${(worstRel * 100).toExponential(2)}% of N`);
		// faithful to the joint engine: only the getNumberHit pop-size nonlinearity
		// (negligible at 1M) and fractional rounding differ
		expect(worstRel).toBeLessThan(0.005);

		evolver.destroy();
	});
});

// scenario WITH death (exit coupling) — used to check the evolver is skipped
function deathScenario(): Record<string, unknown> {
	const s = scenario();
	const infected = (s.trait as Record<string, unknown>[]).find(t => t.key === 'infected')!;
	(infected.progress as Record<string, unknown>[]).push({
		apply: 'dead', remove: 'infected,immune,support,oppose,employed,unemployed,alive',
		vector: 'mortality', value: 0.02, sd: 0, phase: 'progress',
	});
	(s.trait as Record<string, unknown>[]).push({ key: 'dead' });
	(s.vector as Record<string, unknown>[]).push({ key: 'mortality' });
	return s;
}

describe('FactoredEvolver — WorkerSim integration (C2a)', () => {
	const harness = () => {
		const out: WorkerMsg[] = [];
		return { sim: new WorkerSim(msg => out.push(msg)), out };
	};
	const send = (sim: WorkerSim, msg: ClientMsg) => sim.handle(msg);

	// seeded disease⟺politics correlation with no coupling rule: the detector
	// sees independent clusters, but the joint never factors — the gate must
	// REFUSE to promote (marginal-match alone wouldn't catch this).
	function seededCorrelatedScenario(): Record<string, unknown> {
		return {
			name: 'seeded-correlated', use_date: false,
			phase: [{ key: 'progress' }],
			vector: [{ key: 'pol' }],
			trait: [
				{ key: 'alive' },
				{ key: 'infected' }, { key: 'immune' },
				{ key: 'support', progress: [{ apply: 'oppose', remove: 'support', vector: 'pol', value: 0.02, sd: 0, phase: 'progress' }] },
				{ key: 'oppose' },
			],
			site: [{
				key: 'city', pop: 1_000_000,
				startpop: [
					{ size: 50, apply: 'alive,infected,support' },
					{ size: 50, apply: 'alive,oppose' },
				],
			}],
		};
	}

	const traitTotal = (w: World, key: string): number => {
		let n = 0;
		for (const site of (w as unknown as { sites: { pops: { pop: number; syndrome: { trait_keys: string[] } }[] }[] }).sites)
			for (const p of site.pops) if (p.syndrome.trait_keys.includes(key)) n += p.pop;
		return n;
	};

	it('PROMOTES the evolver on a factorable scenario; reconstructed counts match a joint-only run', async () => {
		const { sim } = harness();
		sim.clustering = true; // on at boot so the evolver tracks from day 0
		sim.clusterWarmupDays = 5;
		await send(sim, { type: 'start', scenario: scenario(), seed: 4242 });
		await send(sim, { type: 'step', count: 20 });

		expect(sim.clusterPromoted).toBe(true);          // joint engine now frozen
		expect(sim.clusterEvolver).not.toBeNull();

		// reference: a plain joint-only run of the same scenario for 20 days
		const sysR = new System(null);
		sysR.rand.seed(4242);
		(sysR as unknown as { renderIfNeeded: () => void }).renderIfNeeded = () => { };
		const ref = new World(sysR as never, scenario());
		(sysR as unknown as { world: World }).world = ref;
		await ref.start();
		for (let i = 0; i < 20; i++) await ref.newDay();

		// the promoted world's populations were reconstructed from the evolver;
		// living trait totals match the joint-only reference
		const promoted = (sim as unknown as { world: World }).world;
		for (const key of ['infected', 'immune', 'support', 'oppose', 'employed', 'unemployed']) {
			const a = traitTotal(promoted, key), b = traitTotal(ref, key);
			expect(Math.abs(a - b) / 1_000_000).toBeLessThan(0.01);
		}
	});

	it('does NOT promote when the joint carries correlation the partition misses', async () => {
		const { sim } = harness();
		sim.clustering = true;
		sim.clusterWarmupDays = 4;
		await send(sim, { type: 'start', scenario: seededCorrelatedScenario(), seed: 1 });
		await send(sim, { type: 'step', count: 6 });

		expect(sim.clusterPromoted).toBe(false); // factorization residual stayed high
		expect(sim.clusterEvolver).toBeNull();   // evolver dropped; joint stays authoritative
	});

	it('builds with the full-strip removal glue when the scenario has death', async () => {
		const { sim } = harness();
		await send(sim, { type: 'start', scenario: deathScenario(), seed: 1 });
		await send(sim, { type: 'setClustering', enabled: true });
		const evolver = await sim.buildClusterEvolver();
		expect(evolver).not.toBeNull();
		expect(evolver!.hasExitCoupling).toBe(true);
	});
});

describe('FactoredEvolver — C2b cross-cluster removal (death, sd=0)', () => {
	it('living marginals track the joint engine as deaths accumulate', async () => {
		const SEED = 909, DAYS = 25, N = 1_000_000;
		const sysJ = new System(null);
		sysJ.rand.seed(SEED);
		(sysJ as unknown as { renderIfNeeded: () => void }).renderIfNeeded = () => { };
		const joint = new World(sysJ as never, deathScenario());
		(sysJ as unknown as { world: World }).world = joint;
		await joint.start();
		const partition = buildPartition(joint as never);
		expect(partition.report.exitTraits).toContain('alive'); // death detected as exit

		const evolver = await FactoredEvolver.build(deathScenario(), partition, SEED);
		expect(evolver.hasExitCoupling).toBe(true);

		let worstRel = 0, finalLiving = N;
		for (let day = 0; day < DAYS; day++) {
			await joint.newDay();
			await evolver.step();

			// joint's true living total
			let jointLiving = 0;
			const jm = jointMarginals(joint, partition);
			for (const v of jm.get(partition.clusters[0].id)!.values()) jointLiving += v;
			finalLiving = jointLiving;

			// evolver's reconciled living total matches the joint's (relative)
			expect(Math.abs(evolver.trueLivingN() - jointLiving) / N).toBeLessThan(1e-4);

			for (const c of partition.clusters) {
				const diff = maxMarginalDiff(jm.get(c.id)!, evolver.clusterMarginal(c.id));
				worstRel = Math.max(worstRel, diff / N);
			}
		}

		console.log(`[C2b] deaths=${(N - finalLiving).toFixed(0)}, worst living-marginal divergence: ${(worstRel * 100).toExponential(2)}% of N`);
		expect(N - finalLiving).toBeGreaterThan(1000); // deaths actually happened
		expect(worstRel).toBeLessThan(0.005);
		evolver.destroy();
	});
});

// ---- C2b-rest: site immigration (growth) + multi-source death ---------------

// base scenario + an unborn pool + RECURRING immigration owned by the `alive`
// membership trait (replicated into every sub-World, rate ∝ living population),
// adding {alive,support,employed} to unborn units (a fixed entry state).
function immigrationScenario(): Record<string, unknown> {
	const s = scenario();
	(s.vector as Record<string, unknown>[]).push({ key: 'immig', seek: [{ trait: 'alive', mult: 0 }] });
	const alive = (s.trait as Record<string, unknown>[]).find(t => t.key === 'alive')! as { transmit?: Record<string, unknown>[] };
	alive.transmit = [{ apply: 'alive,support,employed', vector: 'immig', value: 0.006, sd: 0, phase: 'spread' }];
	const site = (s.site as Record<string, unknown>[])[0];
	(site.startpop as Record<string, unknown>[]).push({ size: 120, apply: '' }); // unborn pool to draw from
	return s;
}

// deathScenario + a second, independent death owned by the economics cluster
function multiDeathScenario(): Record<string, unknown> {
	const s = deathScenario();
	(s.vector as Record<string, unknown>[]).push({ key: 'starvation' });
	const unemployed = (s.trait as Record<string, unknown>[]).find(t => t.key === 'unemployed')! as { progress?: Record<string, unknown>[] };
	unemployed.progress = unemployed.progress ?? [];
	unemployed.progress.push({ apply: 'dead', remove: 'employed,unemployed,support,oppose,infected,immune,alive', vector: 'starvation', value: 0.015, sd: 0, phase: 'progress' });
	return s;
}

describe('FactoredEvolver — C2b-rest (immigration + multi-source death, sd=0)', () => {
	async function dualTrack(make: () => Record<string, unknown>, days: number, seed: number) {
		const N = 1_000_000;
		const sysJ = new System(null);
		sysJ.rand.seed(seed);
		(sysJ as unknown as { renderIfNeeded: () => void }).renderIfNeeded = () => { };
		const joint = new World(sysJ as never, make());
		(sysJ as unknown as { world: World }).world = joint;
		await joint.start();
		const partition = buildPartition(joint as never);
		const evolver = await FactoredEvolver.build(make(), partition, seed);

		const livingOf = (w: World) => {
			let n = 0;
			for (const v of jointMarginals(w, partition).get(partition.clusters[0].id)!.values()) n += v;
			return n;
		};
		const initialLiving = livingOf(joint);
		let worstRel = 0, jointLiving = initialLiving;
		for (let day = 0; day < days; day++) {
			await joint.newDay();
			await evolver.step();
			const jm = jointMarginals(joint, partition);
			jointLiving = 0;
			for (const v of jm.get(partition.clusters[0].id)!.values()) jointLiving += v;
			expect(Math.abs(evolver.trueLivingN() - jointLiving) / N).toBeLessThan(2e-4);
			for (const c of partition.clusters) worstRel = Math.max(worstRel, maxMarginalDiff(jm.get(c.id)!, evolver.clusterMarginal(c.id)) / N);
		}
		evolver.destroy();
		return { worstRel, jointLiving, initialLiving, N };
	}

	it('recurring immigration grows the living total; marginals track the joint', async () => {
		const { worstRel, jointLiving, initialLiving } = await dualTrack(immigrationScenario, 20, 313);
		console.log(`[C2b-rest immig] living ${initialLiving.toFixed(0)} -> ${jointLiving.toFixed(0)}, worst divergence ${(worstRel * 100).toExponential(2)}% of N`);
		expect(jointLiving).toBeGreaterThan(initialLiving * 1.02); // population grew via immigration
		expect(worstRel).toBeLessThan(0.005);
	});

	it('two independent death sources reconcile; marginals track the joint', async () => {
		const { worstRel, jointLiving, N } = await dualTrack(multiDeathScenario, 25, 717);
		console.log(`[C2b-rest multi-death] final living=${jointLiving.toFixed(0)}, worst divergence ${(worstRel * 100).toExponential(2)}% of N`);
		expect(N - jointLiving).toBeGreaterThan(1000); // deaths from both sources
		expect(worstRel).toBeLessThan(0.005);
	});
});

// ---- C2c: shared stockpile (aggregate coupling) -----------------------------

// `tension` is produced by the DISEASE cluster (∝ infected) and read as a
// modifier on the POLITICS cluster's support→oppose rate. The two are separate
// clusters (aggregate coupling does not merge); the evolver must share the
// resource value across sub-Worlds.
function resourceCouplingScenario(): Record<string, unknown> {
	return {
		name: 'C2c resource coupling', use_date: false,
		phase: [{ key: 'spread' }, { key: 'progress' }],
		vector: [{ key: 'air', seek: [{ not_trait: 'alive', mult: 0 }] }, { key: 'recovery' }, { key: 'pol' }, { key: 'eco' }],
		resource: [{ key: 'tension', value: 100, global: 1, signed: 1 }],
		trait: [
			{ key: 'alive' },
			{
				key: 'infected',
				transmit: [{ apply: 'infected', vector: 'air', value: 0.25, sd: 0, phase: 'spread' }],
				progress: [{ apply: 'immune', remove: 'infected', vector: 'recovery', value: 0.1, sd: 0, phase: 'progress' }],
				produce: [{ resource: 'tension', value: 0.000002, phase: 'progress' }],
			},
			{ key: 'immune' },
			{
				key: 'support',
				progress: [{ apply: 'oppose', remove: 'support', vector: 'pol', value: 0.0003, sd: 0, phase: 'progress' }],
				progress_mod: [{ vector: 'pol', mult: 'tension' }], // rate scaled by the shared resource
			},
			{ key: 'oppose', progress: [{ apply: 'support', remove: 'oppose', vector: 'pol', value: 0.02, sd: 0, phase: 'progress' }] },
			{ key: 'employed', progress: [{ apply: 'unemployed', remove: 'employed', vector: 'eco', value: 0.05, sd: 0, phase: 'progress' }] },
			{ key: 'unemployed', progress: [{ apply: 'employed', remove: 'unemployed', vector: 'eco', value: 0.05, sd: 0, phase: 'progress' }] },
		],
		site: [{
			key: 'city', pop: 1_000_000,
			startpop: [
				{ size: 30, apply: 'alive,support,employed' },
				{ size: 30, apply: 'alive,support,unemployed' },
				{ size: 20, apply: 'alive,oppose,employed' },
				{ size: 20, apply: 'alive,oppose,unemployed' },
			],
			transmit: [{ apply: 'infected', vector: 'air', value: 50000, sd: 0, phase: 'spread' }],
		}],
	};
}

describe('FactoredEvolver — C2c shared stockpile (aggregate coupling, sd=0)', () => {
	it('disease produces a resource that modifies politics; clusters stay separate and marginals track', async () => {
		const SEED = 5151, DAYS = 20, N = 1_000_000;
		const sysJ = new System(null);
		sysJ.rand.seed(SEED);
		(sysJ as unknown as { renderIfNeeded: () => void }).renderIfNeeded = () => { };
		const joint = new World(sysJ as never, resourceCouplingScenario());
		(sysJ as unknown as { world: World }).world = joint;
		await joint.start();
		const partition = buildPartition(joint as never);

		// aggregate coupling must NOT merge disease and politics
		const diseaseCluster = partition.clusters.find(c => c.traitKeys.has('infected'))!;
		expect(diseaseCluster.traitKeys.has('support')).toBe(false);

		const evolver = await FactoredEvolver.build(resourceCouplingScenario(), partition, SEED);

		const jointTension = () => {
			const stocks = (joint as unknown as { all_stockpiles: { resource: { key: string }; value: number }[] }).all_stockpiles;
			return stocks.find(s => s.resource.key === 'tension')!.value;
		};

		let worstRel = 0, finalTension = 100;
		for (let day = 0; day < DAYS; day++) {
			await joint.newDay();
			await evolver.step();
			finalTension = jointTension();
			// the shared resource tracks the joint's stockpile (≤ 1-day lag)
			expect(Math.abs(evolver.sharedStockpileValue('tension')! - finalTension) / finalTension).toBeLessThan(0.02);
			const jm = jointMarginals(joint, partition);
			for (const c of partition.clusters) worstRel = Math.max(worstRel, maxMarginalDiff(jm.get(c.id)!, evolver.clusterMarginal(c.id)) / N);
		}

		console.log(`[C2c] tension ${100} -> ${finalTension.toFixed(1)}, worst marginal divergence ${(worstRel * 100).toExponential(2)}% of N`);
		expect(finalTension).toBeGreaterThan(100); // resource accumulated from infections
		expect(worstRel).toBeLessThan(0.01); // small residual from the 1-day aggregate lag
		evolver.destroy();
	});
});

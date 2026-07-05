/**
 * Phase C3 — dynamic split / merge through a coupling that toggles mid-run.
 *
 * `gate` is a resource that gates a PER-UNIT coupling: when `gate ≠ 1`, infected
 * units shift politics at a different rate (a Test-4-style merge coupling); when
 * `gate = 1` the modifier is a no-op and disease/politics are independent.
 *
 * We drive gate 1 → 2 → 1 and require the evolver to:
 *   - run SPLIT while gate = 1 (cheaper),
 *   - MERGE when gate activates (capturing the correlation it builds),
 *   - SPLIT BACK only after gate deactivates AND the joint decorrelates,
 * all while its reconstructed cross-cluster counts track a joint-only run.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import '../../../wireup';
import { System } from '../../../controller/System';
import { World } from '../../../controller/World';
import { buildPartition } from '../ClusterPartition';
import { detectClusters } from '../ClusterDetector';
import { FactoredEvolver } from '../FactoredEvolver';
import { WorkerSim } from '../../workerSim';
import type { ClientMsg } from '../../protocol';

beforeAll(() => {
	if (!document.getElementById('wrapper')) {
		const wrapper = document.createElement('div');
		wrapper.id = 'wrapper';
		document.body.appendChild(wrapper);
	}
});

function toggleScenario(): Record<string, unknown> {
	return {
		name: 'C3 gated coupling', use_date: false,
		phase: [{ key: 'spread' }, { key: 'progress' }],
		vector: [{ key: 'air', seek: [{ not_trait: 'alive', mult: 0 }] }, { key: 'recovery' }, { key: 'radicalize' }, { key: 'moderate' }, { key: 'eco' }],
		resource: [{ key: 'gate', value: 1, global: 1, signed: 1 }],
		trait: [
			{ key: 'alive' },
			{
				key: 'infected',
				transmit: [{ apply: 'infected', vector: 'air', value: 0.2, sd: 0, phase: 'spread' }],
				progress: [{ apply: 'immune', remove: 'infected', vector: 'recovery', value: 0.08, sd: 0, phase: 'progress' }],
				// ASYMMETRIC gated coupling: infected radicalize (support→oppose) ×gate
				// but moderate (oppose→support) is unaffected. gate=1 → same rate as
				// everyone (no correlation); gate>1 → infected skew oppose (correlation).
				progress_mod: [{ vector: 'radicalize', mult: 'gate' }],
			},
			{ key: 'immune' },
			{ key: 'support', progress: [{ apply: 'oppose', remove: 'support', vector: 'radicalize', value: 0.1, sd: 0, phase: 'progress' }] },
			{ key: 'oppose', progress: [{ apply: 'support', remove: 'oppose', vector: 'moderate', value: 0.1, sd: 0, phase: 'progress' }] },
			{ key: 'employed', progress: [{ apply: 'unemployed', remove: 'employed', vector: 'eco', value: 0.04, sd: 0, phase: 'progress' }] },
			{ key: 'unemployed', progress: [{ apply: 'employed', remove: 'unemployed', vector: 'eco', value: 0.04, sd: 0, phase: 'progress' }] },
		],
		site: [{
			key: 'city', pop: 1_000_000,
			startpop: [
				{ size: 25, apply: 'alive,support,employed' },
				{ size: 25, apply: 'alive,support,unemployed' },
				{ size: 25, apply: 'alive,oppose,employed' },
				{ size: 25, apply: 'alive,oppose,unemployed' },
			],
			transmit: [{ apply: 'infected', vector: 'air', value: 80000, sd: 0, phase: 'spread' }],
		}],
	};
}

const setJointGate = (w: World, g: number): void => {
	const stocks = (w as unknown as { all_stockpiles: { resource: { key: string }; setValue(v: number): void }[] }).all_stockpiles;
	stocks.find(s => s.resource.key === 'gate')?.setValue(g);
};
const jointSyndromeCount = (w: World, keys: string[]): number => {
	let n = 0;
	for (const site of (w as unknown as { sites: { pops: { pop: number; syndrome: { trait_keys: string[] } }[] }[] }).sites)
		for (const p of site.pops) if (keys.every(k => p.syndrome.trait_keys.includes(k))) n += p.pop;
	return n;
};
const together = (groups: string[][], a: string, b: string) => groups.some(g => g.includes(a) && g.includes(b));

describe('FactoredEvolver — C3 dynamic split/merge (sd=0)', () => {
	it('merges on activation, splits back after decorrelation, tracks the joint throughout', async () => {
		const SEED = 31, N = 1_000_000;
		const sys = new System(null);
		sys.rand.seed(SEED);
		(sys as unknown as { renderIfNeeded: () => void }).renderIfNeeded = () => { };
		const joint = new World(sys as never, toggleScenario());
		(sys as unknown as { world: World }).world = joint;
		await joint.start();

		// structural partition would merge disease+politics (gate edge active)...
		expect(buildPartition(joint as never).clusters.find(c => c.traitKeys.has('infected'))!.traitKeys.has('support')).toBe(true);
		// ...but gate starts at 1 (off), so build from the ACTIVE partition: disease
		// and politics start as separate sub-Worlds (no day-0 rebuild).
		const active0 = buildPartition(joint as never, { resourceValues: { gate: 1 } });
		expect(active0.clusters.find(c => c.traitKeys.has('infected'))!.traitKeys.has('support')).toBe(false);

		const evolver = await FactoredEvolver.build(toggleScenario(), active0, SEED);

		const gateAt = (day: number) => (day >= 5 && day < 18) ? 2 : 1;
		let splitWhileOff = false, mergedWhileOn = false, splitBackAfter = false, worstCross = 0;
		let econEverMerged = false;

		for (let day = 0; day < 44; day++) {
			const g = gateAt(day);
			setJointGate(joint, g);
			evolver.setSharedStockpile('gate', g);

			// active partition for the current gate value, then reconcile sub-Worlds
			const active = detectClusters(joint as never, { resourceValues: { gate: g } }).clusters;
			await evolver.repartition(active, 2e-3);

			await joint.newDay();
			await evolver.step();

			const grp = evolver.currentGroups();
			const dpTogether = together(grp, 'infected', 'support');
			if (g === 1 && day < 5 && !dpTogether) splitWhileOff = true;
			if (g === 2 && dpTogether) mergedWhileOn = true;
			if (g === 1 && day > 30 && !dpTogether) splitBackAfter = true;
			if (together(grp, 'infected', 'employed') || together(grp, 'support', 'employed')) econEverMerged = true;

			// the reconstructed cross-cluster count tracks the joint at all times
			const jc = jointSyndromeCount(joint, ['infected', 'oppose']);
			const ec = evolver.combinedCount(['infected', 'oppose']);
			worstCross = Math.max(worstCross, Math.abs(jc - ec) / N);
		}

		console.log(`[C3] splitOff=${splitWhileOff} mergedOn=${mergedWhileOn} splitBack=${splitBackAfter} ` +
			`econMerged=${econEverMerged} worstCross=${(worstCross * 100).toExponential(2)}% of N`);

		expect(splitWhileOff).toBe(true);     // ran split while the coupling was off
		expect(mergedWhileOn).toBe(true);     // merged when it activated
		expect(splitBackAfter).toBe(true);    // split back once decorrelated
		expect(econEverMerged).toBe(false);   // the uncoupled economics cluster never merged
		expect(worstCross).toBeLessThan(0.01); // tracked the joint's correlation throughout
		evolver.destroy();
	});

	it('re-partitions through the WorkerSim day loop, tracking a joint-only run', async () => {
		const N = 1_000_000;
		const sim = new WorkerSim(() => { });
		sim.clustering = true;
		sim.clusterWarmupDays = 3;
		sim.clusterSplitEps = 2e-3;
		const send = (m: ClientMsg) => sim.handle(m);
		await send({ type: 'start', scenario: toggleScenario(), seed: 31 });

		// joint-only reference driven with the same gate schedule
		const sysR = new System(null);
		sysR.rand.seed(31);
		(sysR as unknown as { renderIfNeeded: () => void }).renderIfNeeded = () => { };
		const ref = new World(sysR as never, toggleScenario());
		(sysR as unknown as { world: World }).world = ref;
		await ref.start();

		const gateAt = (day: number) => (day >= 5 && day < 18) ? 2 : 1;
		let promoted = false, mergedOn = false, splitBack = false, worst = 0;
		for (let day = 0; day < 44; day++) {
			const g = gateAt(day);
			setJointGate((sim as unknown as { world: World }).world, g); // pre-promotion joint
			sim.clusterEvolver?.setSharedStockpile('gate', g);           // post-promotion driver
			setJointGate(ref, g);

			await send({ type: 'step', count: 1 });
			await ref.newDay();

			if (sim.clusterPromoted) promoted = true;
			const grp = sim.clusterEvolver?.currentGroups() ?? [];
			if (g === 2 && together(grp, 'infected', 'support')) mergedOn = true;
			if (g === 1 && day > 30 && !together(grp, 'infected', 'support')) splitBack = true;

			// sim.world's populations are the live joint (warmup) or reconstructed
			// from the evolver (promoted); either way they track the reference
			const sc = jointSyndromeCount((sim as unknown as { world: World }).world, ['infected', 'oppose']);
			const rc = jointSyndromeCount(ref, ['infected', 'oppose']);
			worst = Math.max(worst, Math.abs(sc - rc) / N);
		}
		console.log(`[C3 loop] promoted=${promoted} mergedOn=${mergedOn} splitBack=${splitBack} worst=${(worst * 100).toFixed(2)}%`);
		expect(promoted).toBe(true);
		expect(mergedOn).toBe(true);
		expect(splitBack).toBe(true);
		expect(worst).toBeLessThan(0.02);
	});
});

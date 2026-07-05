/**
 * Phase C1 validation:
 *   (a) deterministic verifier math — product joint factors (residual ~0),
 *       correlated joint does not (residual large);
 *   (b) live multi-cluster scenario — the simulated joint factors along the
 *       detected partition (residual stays small) and factoring saves storage;
 *   (c) COVID — runs, and the verifier reports it as a non-benefit (one blob).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import '../../../wireup';
import { System } from '../../../controller/System';
import { World } from '../../../controller/World';
import { ClusterPartition, buildPartition } from '../ClusterPartition';
import { verifyFactorization } from '../ClusterVerifier';
import type { ClusterReport } from '../ClusterDetector';
import covidScenario from '../../../../example-scenarios/covid-19.json';

beforeAll(() => {
	if (!document.getElementById('wrapper')) {
		const wrapper = document.createElement('div');
		wrapper.id = 'wrapper';
		document.body.appendChild(wrapper);
	}
});

// ---- (a) deterministic verifier math ---------------------------------------

function fakeReport(clusters: string[][]): ClusterReport {
	return { clusters, membership: [], terminal: [], exitTraits: [], gateEdges: [], traitCount: clusters.flat().length };
}
// world stub: one site with the given (trait_keys, count) populations
function stubWorld(pops: { traits: string[]; pop: number }[]) {
	return { sites: [{ key: 's', pops: pops.map(p => ({ pop: p.pop, syndrome: { trait_keys: p.traits } })) }] };
}

describe('verifyFactorization — math', () => {
	const partition = new ClusterPartition(fakeReport([['infected', 'immune'], ['oppose']]));
	// marginals: disease {'':0.5,'infected':0.3,'immune':0.2}, politics {'':0.6,'oppose':0.4}
	const dm: [string[], number][] = [[[], 50], [['infected'], 30], [['immune'], 20]];
	const pm: [string[], number][] = [[[], 60], [['oppose'], 40]];

	it('product joint factors: residual ~ 0', () => {
		const pops: { traits: string[]; pop: number }[] = [];
		for (const [d, dn] of dm) for (const [p, pn] of pm) pops.push({ traits: [...d, ...p], pop: (dn * pn) / 100 });
		const v = verifyFactorization(stubWorld(pops), partition);
		expect(v.maxResidual).toBeLessThan(1e-9);
		// factored: disease(3) + politics(2) = 5 states vs 6 joint pops
		expect(v.factoredStatesTotal).toBe(5);
		expect(v.jointPopsTotal).toBe(6);
		expect(v.costRatio).toBeCloseTo(5 / 6, 5);
	});

	it('correlated joint does NOT factor: residual large', () => {
		// force perfect correlation: infected only among oppose, immune only among support
		const pops = [
			{ traits: [], pop: 30 },             // susceptible+support
			{ traits: ['oppose'], pop: 0.0001 }, // (negligible)
			{ traits: ['infected', 'oppose'], pop: 40 },
			{ traits: ['immune'], pop: 30 },
		];
		const v = verifyFactorization(stubWorld(pops), partition);
		expect(v.maxResidual).toBeGreaterThan(0.1);
	});
});

// ---- (b) live multi-cluster scenario ---------------------------------------

function multiClusterScenario(): Record<string, unknown> {
	return {
		name: 'C1 multi-cluster', use_date: false,
		phase: [{ key: 'spread' }, { key: 'progress' }, { key: 'death' }],
		vector: [
			{ key: 'air', seek: [{ not_trait: 'alive', mult: 0 }] },
			{ key: 'recovery' }, { key: 'mortality' }, { key: 'pol' }, { key: 'eco' },
		],
		trait: [
			{ key: 'alive', name: 'Alive' },
			{
				key: 'infected', name: 'Infected', color: '255,0,0,1',
				transmit: [{ apply: 'infected', vector: 'air', value: 0.25, phase: 'spread' }],
				progress: [
					{ apply: 'immune', remove: 'infected', vector: 'recovery', value: 0.1, phase: 'progress' },
					{ apply: 'dead', remove: 'infected,immune,support,oppose,employed,unemployed,alive', vector: 'mortality', value: 0.02, phase: 'death' },
				],
			},
			{ key: 'immune', name: 'Immune' },
			{ key: 'dead', name: 'Dead' },
			{ key: 'support', name: 'Support', progress: [{ apply: 'oppose', remove: 'support', vector: 'pol', value: 0.05, phase: 'progress' }] },
			{ key: 'oppose', name: 'Oppose', progress: [{ apply: 'support', remove: 'oppose', vector: 'pol', value: 0.05, phase: 'progress' }] },
			{ key: 'employed', name: 'Employed', progress: [{ apply: 'unemployed', remove: 'employed', vector: 'eco', value: 0.04, phase: 'progress' }] },
			{ key: 'unemployed', name: 'Unemployed', progress: [{ apply: 'employed', remove: 'unemployed', vector: 'eco', value: 0.04, phase: 'progress' }] },
		],
		site: [{
			key: 'city', name: 'City', pop: 1_000_000,
			startpop: [
				{ size: 30, apply: 'alive,support,employed' },
				{ size: 30, apply: 'alive,support,unemployed' },
				{ size: 20, apply: 'alive,oppose,employed' },
				{ size: 20, apply: 'alive,oppose,unemployed' },
			],
			// inject infection independent of politics/economics (random alive targets)
			transmit: [{ apply: 'infected', vector: 'air', value: 40000, phase: 'spread' }],
		}],
	};
}

describe('verifyFactorization — live multi-cluster scenario', () => {
	it('the simulated joint factors along the partition, and factoring saves', async () => {
		const system = new System(null);
		system.rand.seed(777);
		(system as unknown as { renderIfNeeded: () => void }).renderIfNeeded = () => { };
		const world = new World(system as never, multiClusterScenario());
		(system as unknown as { world: World }).world = world;
		await world.start();

		const partition = buildPartition(world as never);
		// disease / politics / economics are independent multi-trait clusters
		expect(partition.multiClusterCount).toBeGreaterThanOrEqual(3);

		for (let i = 0; i < 25; i++) await world.newDay();

		const v = verifyFactorization(world as never, partition);
		const s = v.sites[0];
		console.log(`[C1] living=${s.livingN.toFixed(0)} absorbed=${s.absorbedN.toFixed(0)} ` +
			`jointPops=${s.jointPops} factoredStates=${s.factoredStates} ` +
			`residual=${s.residual.toExponential(2)} costRatio=${v.costRatio.toFixed(3)}`);

		// independent clusters => the joint factors (small residual, sampling noise only)
		expect(v.maxResidual).toBeLessThan(0.02);
		// factoring tracks fewer states than the joint
		expect(v.costRatio).toBeLessThan(0.95);
		expect(s.absorbedN).toBeGreaterThan(0); // some deaths occurred
	});
});

// ---- (c) COVID: runs, reports as a non-benefit ------------------------------

describe('verifyFactorization — COVID', () => {
	it('runs and reports the entangled blob (no factoring benefit)', async () => {
		const system = new System(null);
		system.rand.seed(12345);
		(system as unknown as { renderIfNeeded: () => void }).renderIfNeeded = () => { };
		const world = new World(system as never, JSON.parse(JSON.stringify(covidScenario)));
		(system as unknown as { world: World }).world = world;
		await world.start();
		const partition = buildPartition(world as never);
		for (let i = 0; i < 20; i++) await world.newDay();

		const v = verifyFactorization(world as never, partition);
		console.log(`[C1 covid] jointPops=${v.jointPopsTotal} factoredStates=${v.factoredStatesTotal} ` +
			`residual=${v.maxResidual.toExponential(2)} costRatio=${v.costRatio.toFixed(3)}`);
		// The joint factors validly along the partition over BASE traits (residual
		// ~0) — confirming the detector. Even the "entangled blob" has a few
		// peripheral independent base traits, so factoring saves modestly
		// (costRatio < 1 but near it) — far less than a sparse story scenario.
		expect(v.maxResidual).toBeLessThan(0.02);
		expect(v.costRatio).toBeLessThan(1.0);
		expect(v.costRatio).toBeGreaterThan(0.5);
	});
});

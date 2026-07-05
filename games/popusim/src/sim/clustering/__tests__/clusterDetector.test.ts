/**
 * Phase C0 validation: the static cluster detector against
 *   (a) the real COVID World (proves the runtime binding is correct), and
 *   (b) synthetic Test 1-4 worlds (proves the coupling criterion), mirroring
 *       planning-docs/synthetic-tests.mjs.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import '../../../wireup';
import { System } from '../../../controller/System';
import { World } from '../../../controller/World';
import { detectClusters } from '../ClusterDetector';
import covidScenario from '../../../../example-scenarios/covid-19.json';

beforeAll(() => {
	if (!document.getElementById('wrapper')) {
		const wrapper = document.createElement('div');
		wrapper.id = 'wrapper';
		document.body.appendChild(wrapper);
	}
});

// ---- (a) real COVID world ---------------------------------------------------

describe('detectClusters — COVID runtime binding', () => {
	it('finds the entangled blob + verified-terminal alive', async () => {
		const system = new System(null);
		system.rand.seed(12345);
		(system as unknown as { renderIfNeeded: () => void }).renderIfNeeded = () => { };
		const world = new World(system as never, JSON.parse(JSON.stringify(covidScenario)));
		(system as unknown as { world: World }).world = world;
		await world.start();

		const r = detectClusters(world as never);

		// membership read from startpop seeds; terminality verified via birth seek
		expect(r.membership).toEqual(['alive']);
		expect(r.terminal).toEqual(['alive']);

		// COVID is intrinsically one big cluster, everything else singletons
		const multi = r.clusters.filter(c => c.length > 1);
		expect(multi.length).toBe(1);
		expect(multi[0].length).toBeGreaterThan(15);
		for (const k of ['alive', 'infected', 'severe', 'dead', 'child', 'adult', 'senior', 'immune']) {
			expect(multi[0]).toContain(k);
		}

		// the death bundle is decremented out as a terminal exit
		expect(r.exitTraits).toContain('alive');
		expect(r.exitTraits.length).toBeGreaterThan(5);

		// COVID uses resource-tied modifiers (stat_*), so gate edges exist
		expect(r.gateEdges.length).toBeGreaterThan(0);
	});
});

// ---- (b) synthetic Test 1-4 -------------------------------------------------

type Rule = { trait_keys?: string[]; cure_keys?: string[]; vector_keys?: string[]; require_keys?: string[]; forbid_keys?: string[] };
type Mod = { vector_keys?: string[]; mult?: number | string; trait_keys?: string[]; cure_keys?: string[] };
type Trait = { key: string; transmit?: Rule[]; progress?: Rule[]; progress_mod?: Mod[] };

function baseWorld() {
	const traits: Trait[] = [
		{ key: 'alive' },
		{
			key: 'infected',
			transmit: [{ trait_keys: ['infected'], vector_keys: ['air'] }],
			progress: [
				{ trait_keys: ['immune'], cure_keys: ['infected'], vector_keys: ['recovery'] },
				{ trait_keys: ['dead'], cure_keys: ['infected', 'immune', 'support', 'neutral', 'oppose', 'employed', 'unemployed', 'alive'], vector_keys: ['illness'] },
			],
		},
		{ key: 'immune' },
		{ key: 'dead' },
		{ key: 'support', progress: [{ trait_keys: ['neutral'], cure_keys: ['support'], vector_keys: ['politics'] }] },
		{ key: 'neutral', progress: [{ trait_keys: ['oppose'], cure_keys: ['neutral'], vector_keys: ['politics'] }] },
		{ key: 'oppose' },
		{ key: 'employed', progress: [{ trait_keys: ['unemployed'], cure_keys: ['employed'], vector_keys: ['econ'] }] },
		{ key: 'unemployed' },
	];
	return {
		traits,
		vectors: ['air', 'recovery', 'politics', 'econ', 'illness', 'vision', 'fearshift'].map(key => ({ key, seek: [] })),
		sites: [{ startpops: [
			{ size: 1 },
			{ size: 33, apply: ['alive', 'infected', 'support', 'employed'] },
			{ size: 33, apply: ['alive', 'immune', 'neutral', 'unemployed'] },
			{ size: 33, apply: ['alive', 'oppose', 'employed'] },
		], transmit: [] }],
	};
}
const t = (w: ReturnType<typeof baseWorld>, k: string) => w.traits.find(x => x.key === k)!;
const partition = (w: ReturnType<typeof baseWorld>) =>
	detectClusters(w as never).clusters
		.filter(c => c.length > 1)
		.map(c => c.slice().sort().join(','))
		.sort();

describe('detectClusters — synthetic criterion (Tests 1-4)', () => {
	it('Test 1: independent + uniform-death exit -> 3 separate clusters', () => {
		expect(partition(baseWorld())).toEqual([
			'dead,immune,infected', 'employed,unemployed', 'neutral,oppose,support',
		]);
	});

	it('Test 4: politically-weighted death (resource-gated) -> disease+political MERGE', () => {
		const w = baseWorld();
		t(w, 'oppose').progress_mod = [{ vector_keys: ['illness'], mult: 'death_weight' }];
		expect(partition(w)).toEqual([
			'dead,immune,infected,neutral,oppose,support', 'employed,unemployed',
		]);
		// and the gating resource is surfaced for the split phase
		const r = detectClusters(w as never);
		expect(r.gateEdges.some(e => e.resource === 'death_weight')).toBe(true);
	});

	it('Test 3: fear via transmit (aggregate) -> disease stays SEPARATE', () => {
		const w = baseWorld();
		t(w, 'infected').transmit!.push({ trait_keys: ['afraid'], vector_keys: ['vision'] });
		w.traits.push({ key: 'afraid', progress: [{ trait_keys: ['oppose'], cure_keys: ['support', 'neutral'], vector_keys: ['fearshift'] }] });
		expect(partition(w)).toEqual([
			'afraid,neutral,oppose,support', 'dead,immune,infected', 'employed,unemployed',
		]);
	});

	it('Test 2: injury via progress (internal) -> disease+political MERGE', () => {
		const w = baseWorld();
		t(w, 'infected').progress!.push({ trait_keys: ['injured'], vector_keys: ['illness'] });
		w.traits.push({ key: 'injured', progress: [{ trait_keys: ['oppose'], cure_keys: ['support', 'neutral'], vector_keys: ['fearshift'] }] });
		expect(partition(w)).toEqual([
			'dead,immune,infected,injured,neutral,oppose,support', 'employed,unemployed',
		]);
	});
});

// hospitalized: a data-RETAINING trait (the unit stays alive with all its data),
// unlike death/emigration which strip everything. It must never be treated as a
// removal/exit; it either stays within a cluster or forces a merge if it spans.
describe('detectClusters — hospitalized (data-retaining, not a removal)', () => {
	function withHospital(spanning: boolean) {
		const w = baseWorld();
		// add an economics cluster so spanning has somewhere to reach
		w.traits.push({ key: 'employed', progress: [{ trait_keys: ['unemployed'], cure_keys: ['employed'], vector_keys: ['eco'] }] } as never);
		w.traits.push({ key: 'unemployed', progress: [{ trait_keys: ['employed'], cure_keys: ['unemployed'], vector_keys: ['eco'] }] } as never);
		w.vectors.push({ key: 'eco', seek: [] }, { key: 'hosp', seek: [] });
		// infected -> hospitalized (stays alive; no membership removed)
		t(w, 'infected').progress!.push({ trait_keys: ['hospitalized'], vector_keys: ['hosp'] });
		const hosp: { key: string; progress_mod?: { vector_keys: string[]; mult: number }[] } = { key: 'hospitalized' };
		// within-cluster: hospitalized only modifies disease recovery;
		// spanning: hospitalized also modifies the economics progress (couples econ)
		hosp.progress_mod = spanning
			? [{ vector_keys: ['eco'], mult: 0.5 }]
			: [{ vector_keys: ['recovery'], mult: 0.5 }];
		w.traits.push(hosp as never);
		return w;
	}

	it('is never an exit trait (the unit keeps its data)', () => {
		const r = detectClusters(withHospital(false) as never);
		expect(r.exitTraits).not.toContain('hospitalized');
		expect(r.terminal).toEqual(['alive']); // only alive is terminal; hospitalized is not
	});

	it('within-cluster: stays in the disease cluster, economics independent', () => {
		const r = detectClusters(withHospital(false) as never);
		const diseaseCluster = r.clusters.find(c => c.includes('infected'))!;
		expect(diseaseCluster).toContain('hospitalized');
		expect(diseaseCluster).not.toContain('employed');
		const econ = r.clusters.find(c => c.includes('employed'))!;
		expect(econ).not.toContain('infected');
	});

	it('spanning: hospitalized couples disease + economics into one cluster (merge, not removal)', () => {
		const r = detectClusters(withHospital(true) as never);
		const diseaseCluster = r.clusters.find(c => c.includes('infected'))!;
		expect(diseaseCluster).toContain('hospitalized');
		expect(diseaseCluster).toContain('employed'); // economics pulled in
		expect(r.exitTraits).not.toContain('hospitalized'); // still not a removal
	});
});

/**
 * Tests the simulation worker's message-handling kernel directly.
 *
 * jsdom can't host a real Worker, and bouncing messages through one
 * would only test postMessage, not the simulation. We instantiate
 * WorkerSim with a captured-callback `post` and drive it with the same
 * ClientMsg shapes the real wire would carry. This exercises every
 * branch of the protocol against a real World.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { WorkerSim } from '../workerSim';
import type { ClientMsg, WorkerMsg, Snapshot } from '../protocol';

beforeAll(() => {
	if (!document.getElementById('wrapper')) {
		const wrapper = document.createElement('div');
		wrapper.id = 'wrapper';
		document.body.appendChild(wrapper);
	}
});

function makeScenario(): Record<string, unknown> {
	return {
		name: 'WorkerSim test',
		start_age: 0,
		use_date: false,
		phase: [{ key: 'spread', name: 'Spread' }],
		trait: [
			{
				key: 'infected',
				name: 'Infected',
				color: '255,0,0,1',
				prob: 0.05,
				transmit: [
					{
						vector: ['v1'],
						apply: ['infected'],
						value: 0.5,
						sd: 0,
						phase: 'spread',
					},
				],
			},
		],
		vector: [{ key: 'v1', name: 'V1' }],
		site: [{ key: 'site_a', name: 'Site A', pop: 1000 }],
	};
}

/** Drives a WorkerSim and collects every emitted WorkerMsg. */
function harness(): { sim: WorkerSim; out: WorkerMsg[] } {
	const out: WorkerMsg[] = [];
	const sim = new WorkerSim(msg => out.push(msg));
	return { sim, out };
}

async function send(sim: WorkerSim, msg: ClientMsg): Promise<void> {
	await sim.handle(msg);
}

describe('WorkerSim', () => {
	// World.start runs one full day internally before returning, so age is 1
	// after start. Subsequent step(N) advances to 1+N. This matches legacy.
	it('start emits a started snapshot with the first day already run', async () => {
		const { sim, out } = harness();
		await send(sim, { type: 'start', scenario: makeScenario(), seed: 12345 });

		expect(out.length).toBe(1);
		expect(out[0].type).toBe('started');
		const snap = (out[0] as { snapshot: Snapshot }).snapshot;
		expect(snap.age).toBe(1);
		expect(snap.sites).toHaveLength(1);
		expect(snap.sites[0].key).toBe('site_a');
		expect(snap.sites[0].pop).toBe(1000);
	});

	it('step advances age and conserves total population', async () => {
		const { sim, out } = harness();
		await send(sim, { type: 'start', scenario: makeScenario(), seed: 12345 });
		await send(sim, { type: 'step', count: 10 });

		const last = out[out.length - 1];
		expect(last.type).toBe('snapshot');
		const snap = (last as { snapshot: Snapshot }).snapshot;
		expect(snap.age).toBe(11);
		const total = snap.sites[0].pops.reduce((a, p) => a + p.pop, 0);
		expect(total).toBe(1000);
	});

	it('reset returns to a fresh world (age 1 after restart)', async () => {
		const { sim, out } = harness();
		await send(sim, { type: 'start', scenario: makeScenario(), seed: 12345 });
		await send(sim, { type: 'step', count: 5 });
		await send(sim, { type: 'reset', scenario: makeScenario(), seed: 12345 });

		const last = out[out.length - 1];
		expect(last.type).toBe('started');
		expect((last as { snapshot: Snapshot }).snapshot.age).toBe(1);
	});

	it('determinism: same seed produces same snapshot trace', async () => {
		const a = harness();
		const b = harness();
		const program: ClientMsg[] = [
			{ type: 'start', scenario: makeScenario(), seed: 42 },
			{ type: 'step', count: 5 },
			{ type: 'step', count: 5 },
		];
		for (const msg of program) {
			await send(a.sim, msg);
			await send(b.sim, msg);
		}
		// Compare snapshot streams.
		expect(a.out.length).toBe(b.out.length);
		for (let i = 0; i < a.out.length; i++) {
			expect(a.out[i]).toEqual(b.out[i]);
		}
	});

	it('different seed produces different trace', async () => {
		// Compare snapshots step-by-step. The scenario converges toward an
		// equilibrium where the *final* counts can match across seeds even
		// when the trajectories differ — so we look for divergence at any
		// intermediate step rather than at the end.
		const a = harness();
		const b = harness();
		await send(a.sim, { type: 'start', scenario: makeScenario(), seed: 1 });
		await send(b.sim, { type: 'start', scenario: makeScenario(), seed: 999 });

		const popsAt = (out: WorkerMsg[]): string => {
			const snap = (out[out.length - 1] as { snapshot: Snapshot }).snapshot;
			return snap.sites[0].pops.map(p => `${p.syndromeKey}=${p.pop}`).sort().join('|');
		};
		let diverged = popsAt(a.out) !== popsAt(b.out);
		for (let i = 0; i < 6 && !diverged; i++) {
			await send(a.sim, { type: 'step', count: 1 });
			await send(b.sim, { type: 'step', count: 1 });
			if (popsAt(a.out) !== popsAt(b.out)) diverged = true;
		}
		expect(diverged).toBe(true);
	});

	it('run loop emits snapshots and pause stops it', async () => {
		const { sim, out } = harness();
		await send(sim, { type: 'start', scenario: makeScenario(), seed: 12345 });
		out.length = 0;

		const runP = sim.handle({ type: 'run', msPerDay: 0, snapshotEveryDays: 1 });
		// Yield a few microtasks so the loop runs a couple of days, then pause.
		for (let i = 0; i < 5; i++) await Promise.resolve();
		await sim.handle({ type: 'pause' });
		await runP;

		// Should see >=1 snapshots followed by a paused.
		const types = out.map(m => m.type);
		expect(types).toContain('snapshot');
		expect(types[types.length - 1]).toBe('paused');
	});

	it('error surfaces when step is called before start', async () => {
		const { sim, out } = harness();
		// We don't expose error emission inside handle directly — that's the
		// glue layer's job. Without start, the World is null, so requireWorld
		// throws synchronously inside handle.
		await expect(sim.handle({ type: 'step', count: 1 })).rejects.toThrow(/before start/);
		expect(out).toEqual([]);
	});

	describe('clustering toggle (Phase C0)', () => {
		it('is off by default — no clusterReport emitted on start', async () => {
			const { sim, out } = harness();
			await send(sim, { type: 'start', scenario: makeScenario(), seed: 1 });
			expect(sim.clustering).toBe(false);
			expect(out.some(m => m.type === 'clusterReport')).toBe(false);
			expect(sim.clusterReport).toBeNull();
		});

		it('emits a clusterReport when toggled on, clears when off', async () => {
			const { sim, out } = harness();
			await send(sim, { type: 'start', scenario: makeScenario(), seed: 1 });
			out.length = 0;

			await send(sim, { type: 'setClustering', enabled: true });
			const report = out.find(m => m.type === 'clusterReport');
			expect(report).toBeDefined();
			if (report && report.type === 'clusterReport') {
				expect(report.report.traitCount).toBeGreaterThan(0);
				expect(Array.isArray(report.report.clusters)).toBe(true);
			}
			expect(sim.clusterReport).not.toBeNull();

			await send(sim, { type: 'setClustering', enabled: false });
			expect(sim.clusterReport).toBeNull();
		});

		it('recomputes on the next boot while enabled', async () => {
			const { sim, out } = harness();
			await send(sim, { type: 'start', scenario: makeScenario(), seed: 1 });
			await send(sim, { type: 'setClustering', enabled: true });
			out.length = 0;
			await send(sim, { type: 'reset', scenario: makeScenario(), seed: 2 });
			expect(out.some(m => m.type === 'clusterReport')).toBe(true);
		});

		it('report carries C1 shadow verification of the current state', async () => {
			const { sim, out } = harness();
			await send(sim, { type: 'start', scenario: makeScenario(), seed: 1 });
			// advance a few days so populations diversify before verifying
			const loop = sim.handle({ type: 'step', count: 5 });
			await loop;
			out.length = 0;
			await send(sim, { type: 'setClustering', enabled: true });

			const m = out.find(x => x.type === 'clusterReport');
			expect(m && m.type === 'clusterReport' && m.report.verification).toBeDefined();
			if (m && m.type === 'clusterReport' && m.report.verification) {
				const ver = m.report.verification;
				expect(ver.maxResidual).toBeLessThan(0.05); // single-cluster scenario factors trivially
				expect(ver.livingN).toBeGreaterThan(0);
				expect(sim.clusterPartition).not.toBeNull();
			}
		});
	});
});

/**
 * Phase C1.x — the factorization monitor (WorkerSim.afterDay).
 *
 * The monitor re-verifies factorization after every simulated day while
 * clustering is active. Two properties:
 *   (a) no false alarms on a genuinely-factored scenario;
 *   (b) it RAISES an alarm when the live joint is correlated in a way the
 *       static detector can't see — here, initial-state correlation seeded by
 *       the scenario with no structural coupling. (The detector reasons from
 *       rules, not state; this is exactly the blind spot the monitor guards.)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { WorkerSim } from '../../workerSim';
import type { ClientMsg, WorkerMsg } from '../../protocol';

beforeAll(() => {
	if (!document.getElementById('wrapper')) {
		const wrapper = document.createElement('div');
		wrapper.id = 'wrapper';
		document.body.appendChild(wrapper);
	}
});

function harness(): { sim: WorkerSim; out: WorkerMsg[] } {
	const out: WorkerMsg[] = [];
	return { sim: new WorkerSim(msg => out.push(msg)), out };
}
const send = (sim: WorkerSim, msg: ClientMsg) => sim.handle(msg);

// independent disease × politics × economics, with mixing -> stays factored
function factoredScenario(): Record<string, unknown> {
	return {
		name: 'monitor-factored', use_date: false,
		phase: [{ key: 'spread' }, { key: 'progress' }],
		vector: [{ key: 'air', seek: [{ not_trait: 'alive', mult: 0 }] }, { key: 'recovery' }, { key: 'pol' }, { key: 'eco' }],
		trait: [
			{ key: 'alive' },
			{
				key: 'infected',
				transmit: [{ apply: 'infected', vector: 'air', value: 0.2, phase: 'spread' }],
				progress: [{ apply: 'immune', remove: 'infected', vector: 'recovery', value: 0.1, phase: 'progress' }],
			},
			{ key: 'immune' },
			{ key: 'support', progress: [{ apply: 'oppose', remove: 'support', vector: 'pol', value: 0.06, phase: 'progress' }] },
			{ key: 'oppose', progress: [{ apply: 'support', remove: 'oppose', vector: 'pol', value: 0.06, phase: 'progress' }] },
			{ key: 'employed', progress: [{ apply: 'unemployed', remove: 'employed', vector: 'eco', value: 0.05, phase: 'progress' }] },
			{ key: 'unemployed', progress: [{ apply: 'employed', remove: 'unemployed', vector: 'eco', value: 0.05, phase: 'progress' }] },
		],
		site: [{
			key: 'city', pop: 1_000_000,
			startpop: [
				{ size: 30, apply: 'alive,support,employed' },
				{ size: 30, apply: 'alive,support,unemployed' },
				{ size: 20, apply: 'alive,oppose,employed' },
				{ size: 20, apply: 'alive,oppose,unemployed' },
			],
			transmit: [{ apply: 'infected', vector: 'air', value: 30000, phase: 'spread' }],
		}],
	};
}

// disease ⟺ politics seeded correlated, NO coupling rule and NO mixing ->
// the static detector says independent, but the joint never factors.
function seededCorrelatedScenario(): Record<string, unknown> {
	return {
		name: 'monitor-correlated', use_date: false,
		phase: [{ key: 'progress' }],
		vector: [{ key: 'v' }],
		trait: [
			{ key: 'alive' },
			{ key: 'infected' },
			{ key: 'support' },
			{ key: 'oppose' },
		],
		site: [{
			key: 'city', pop: 1_000_000,
			// every infected is a supporter; every susceptible opposes
			startpop: [
				{ size: 50, apply: 'alive,infected,support' },
				{ size: 50, apply: 'alive,oppose' },
			],
		}],
	};
}

describe('factorization monitor', () => {
	it('no false alarm on a factored scenario', async () => {
		const { sim } = harness();
		await send(sim, { type: 'start', scenario: factoredScenario(), seed: 99 });
		await send(sim, { type: 'setClustering', enabled: true });
		expect(sim.clusterPartition).not.toBeNull();

		await send(sim, { type: 'step', count: 20 });

		const m = sim.clusterMonitor;
		expect(m.daysChecked).toBe(20);
		expect(m.maxResidualSeen).toBeLessThan(sim.clusterMonitorThreshold);
		expect(m.breaches).toBe(0);
	});

	it('raises an alarm on seeded correlation the detector cannot see', async () => {
		const { sim, out } = harness();
		await send(sim, { type: 'start', scenario: seededCorrelatedScenario(), seed: 1 });
		await send(sim, { type: 'setClustering', enabled: true });
		// detector reasons from rules: with no coupling, disease & politics are
		// separate clusters — but the seeded state is perfectly correlated.
		out.length = 0;

		await send(sim, { type: 'step', count: 3 });

		const m = sim.clusterMonitor;
		expect(m.breaches).toBeGreaterThanOrEqual(1);
		expect(m.maxResidualSeen).toBeGreaterThan(sim.clusterMonitorThreshold);

		// the breach emitted a fresh clusterReport carrying the high residual
		const breachReport = out.find(x =>
			x.type === 'clusterReport' &&
			x.report.verification !== undefined &&
			x.report.verification.maxResidual > sim.clusterMonitorThreshold);
		expect(breachReport).toBeDefined();
	});

	it('breach alarm fires once on the rising edge, not every day', async () => {
		const { sim } = harness();
		await send(sim, { type: 'start', scenario: seededCorrelatedScenario(), seed: 1 });
		await send(sim, { type: 'setClustering', enabled: true });
		await send(sim, { type: 'step', count: 5 });
		// state never changes (no dynamics) so residual stays high every day,
		// but the rising-edge guard means exactly one breach is counted.
		expect(sim.clusterMonitor.breaches).toBe(1);
		expect(sim.clusterMonitor.daysChecked).toBe(5);
	});
});

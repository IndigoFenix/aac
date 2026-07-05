/**
 * Reproduces the editor "Start" flow: an existing WorkerSim is sent a
 * `reset` with the same (real) scenario it was started with. Asserts no
 * console errors are emitted by the simulation during boot or the first
 * few days — historically the second boot was producing
 * "History below 0" warnings from `Population.removeUnits`.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import '../../wireup';
import { WorkerSim } from '../workerSim';
import type { ClientMsg, WorkerMsg } from '../protocol';
import covidScenario from '../../../example-scenarios/covid-19.json';

beforeAll(() => {
	if (typeof document !== 'undefined' && !document.getElementById('wrapper')) {
		const wrapper = document.createElement('div');
		wrapper.id = 'wrapper';
		document.body.appendChild(wrapper);
	}
});

function harness() {
	const out: WorkerMsg[] = [];
	const sim = new WorkerSim((m) => out.push(m));
	return { sim, out };
}

async function send(sim: WorkerSim, msg: ClientMsg): Promise<void> {
	await sim.handle(msg);
}

describe('covid scenario reset', () => {
	it('first start emits no console errors', { timeout: 60000 }, async () => {
		const { sim } = harness();
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => { });
		try {
			const scenarioA = JSON.parse(JSON.stringify(covidScenario));
			await send(sim, { type: 'start', scenario: scenarioA, seed: 12345 });
			await send(sim, { type: 'step', count: 5 });

			const all = errSpy.mock.calls.map(args => args.map(String).join(' '));
			expect(all, `Expected no console.error on first start, got:\n${all.slice(0, 5).join('\n')}`).toEqual([]);
		} finally {
			errSpy.mockRestore();
		}
	});

	it('shutdown then start emits no console errors (editor flow)', { timeout: 120000 }, async () => {
		const { sim, out } = harness();
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => { });
		try {
			await send(sim, { type: 'start', scenario: JSON.parse(JSON.stringify(covidScenario)), seed: 12345 });
			await send(sim, { type: 'step', count: 3 });
			errSpy.mockClear();

			// Mirror the editor's open + Start: shutdown the world, then
			// start a fresh one from the (cloned) draft.
			await send(sim, { type: 'shutdown' });
			expect(out.find(m => m.type === 'shutdown_done')).toBeDefined();

			await send(sim, { type: 'start', scenario: JSON.parse(JSON.stringify(covidScenario)), seed: 12345 });
			await send(sim, { type: 'step', count: 3 });

			const all = errSpy.mock.calls.map(args => args.map(String).join(' '));
			expect(all, `Expected no console.error after shutdown+start, got:\n${all.slice(0, 5).join('\n')}`).toEqual([]);
		} finally {
			errSpy.mockRestore();
		}
	});

	it('pause when not running still resolves the client (no hang)', async () => {
		const { sim, out } = harness();
		await send(sim, { type: 'start', scenario: JSON.parse(JSON.stringify(covidScenario)), seed: 12345 });
		// Sim starts in a non-running state. Pause should still emit `paused`.
		await send(sim, { type: 'pause' });
		const paused = out.filter(m => m.type === 'paused');
		expect(paused.length).toBeGreaterThanOrEqual(1);
	});

	it('reset emits no "History below 0"', { timeout: 120000 }, async () => {
		const { sim } = harness();
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => { });
		try {
			await send(sim, { type: 'start', scenario: JSON.parse(JSON.stringify(covidScenario)), seed: 12345 });
			await send(sim, { type: 'step', count: 3 });
			errSpy.mockClear();

			// Mirror the editor's Start: deep-clone the draft, send reset.
			await send(sim, { type: 'reset', scenario: JSON.parse(JSON.stringify(covidScenario)), seed: 12345 });
			await send(sim, { type: 'step', count: 3 });

			const all = errSpy.mock.calls.map(args => args.map(String).join(' '));
			const histBelow = all.filter(m => m.includes('History below 0'));
			expect(histBelow, `Expected no "History below 0" after reset, got ${histBelow.length}`).toEqual([]);
		} finally {
			errSpy.mockRestore();
		}
	});

	it('reset while a run loop is in flight emits no "History below 0"', { timeout: 120000 }, async () => {
		const { sim } = harness();
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => { });
		try {
			await send(sim, { type: 'start', scenario: JSON.parse(JSON.stringify(covidScenario)), seed: 12345 });
			// Kick the run loop. We don't await — it never returns by itself.
			void sim.handle({ type: 'run', msPerDay: 0, snapshotEveryDays: 1 });
			// Yield so the loop runs at least one day before reset arrives.
			await new Promise(r => setTimeout(r, 30));
			errSpy.mockClear();

			await send(sim, { type: 'pause' });
			await send(sim, { type: 'reset', scenario: JSON.parse(JSON.stringify(covidScenario)), seed: 12345 });
			await send(sim, { type: 'step', count: 3 });

			const all = errSpy.mock.calls.map(args => args.map(String).join(' '));
			const histBelow = all.filter(m => m.includes('History below 0'));
			expect(histBelow, `Expected no "History below 0" after run+pause+reset, got ${histBelow.length}`).toEqual([]);
		} finally {
			errSpy.mockRestore();
		}
	});
});

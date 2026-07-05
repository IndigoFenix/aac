/**
 * Regression: action_vis events must flip the action's visibility in the
 * snapshot. The COVID scenario hides vaccine actions until day 335, then
 * an action_vis event re-enables them.
 *
 * The bug we fixed: workerSim was reading the static `hidden` JSON flag
 * for every snapshot, ignoring the runtime `enabled` field that
 * PlayerAction.init writes from `hidden` and that `action_vis` toggles.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { WorkerSim } from '../workerSim';
import type { WorkerMsg, Snapshot } from '../protocol';

beforeAll(() => {
	if (!document.getElementById('wrapper')) {
		const w = document.createElement('div');
		w.id = 'wrapper';
		document.body.appendChild(w);
	}
});

describe('action_vis events', () => {
	it('flips an action from hidden to visible when the event fires', async () => {
		const out: WorkerMsg[] = [];
		const sim = new WorkerSim(m => out.push(m));

		// A scenario where an action starts hidden and an event flips it
		// visible after age > 2.
		const scenario: Record<string, unknown> = {
			name: 'action_vis repro',
			start_age: 0,
			use_date: false,
			phase: [{ key: 'main', name: 'Main' }],
			trait: [],
			vector: [],
			site: [{ key: 's1', name: 'S1', pop: 100 }],
			action: [
				{ key: 'reveal_me', name: 'Reveal me', global: 1, hidden: 1, max: 1, control: 'checkbox' },
			],
			event: [
				{
					key: 'reveal',
					condition: [
						{ exp: [{ type: 'age' }], op: '>', exp2: [{ value: 2 }] },
					],
					result: [
						{ type: 'action_vis', action: 'reveal_me' },
					],
				},
			],
		};

		await sim.handle({ type: 'start', scenario, seed: 1 });
		const initial = out.find(m => m.type === 'started') as { snapshot: Snapshot };
		const before = initial.snapshot.actions.find(a => a.id === 'reveal_me');
		expect(before).toBeTruthy();
		expect(before!.hidden).toBe(true); // hidden until event fires

		// Step past the trigger day. The condition is `age > 2`; events fire
		// once per phase per day, so a few extra steps are safe.
		await sim.handle({ type: 'step', count: 5 });
		const last = out[out.length - 1] as { snapshot: Snapshot };
		const after = last.snapshot.actions.find(a => a.id === 'reveal_me');
		expect(after).toBeTruthy();
		expect(after!.hidden).toBe(false);
	});
});

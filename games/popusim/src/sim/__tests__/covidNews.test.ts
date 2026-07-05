/**
 * Regression: news items emitted by `display` event results actually arrive
 * in the snapshot. World.addNewsItems was clearing news_pending at end of
 * day before workerSim.snapshot could read it.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { WorkerSim } from '../workerSim';
import type { WorkerMsg, Snapshot } from '../protocol';
import covid from '../../../example-scenarios/covid-19.json';

beforeAll(() => {
	if (!document.getElementById('wrapper')) {
		const w = document.createElement('div');
		w.id = 'wrapper';
		document.body.appendChild(w);
	}
});

describe('COVID scenario news', () => {
	it('emits at least one news item over the first 30 days', async () => {
		const out: WorkerMsg[] = [];
		const sim = new WorkerSim(m => out.push(m));
		await sim.handle({ type: 'start', scenario: JSON.parse(JSON.stringify(covid)), seed: 12345 });
		await sim.handle({ type: 'step', count: 30 });

		const allNews = out
			.filter(m => m.type === 'started' || m.type === 'snapshot')
			.flatMap(m => (m as { snapshot: Snapshot }).snapshot.news);

		expect(allNews.length).toBeGreaterThan(0);
	});
});

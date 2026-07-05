/**
 * End-to-end smoke test against the real COVID-19 fixture.
 *
 * Asserts the invariants that the gameplay GUI relies on:
 *   - bootstrap delivers each site's configured `totalPop`.
 *   - snapshot's `site.pop` matches the configured value.
 *   - populations sum back to the site total (within ±1 from floor rounding).
 *   - no two populations within a site share a syndrome key.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { WorkerSim } from '../workerSim';
import type { WorkerMsg, Snapshot, Bootstrap } from '../protocol';
import covid from '../../../example-scenarios/covid-19.json';

beforeAll(() => {
	if (!document.getElementById('wrapper')) {
		const w = document.createElement('div');
		w.id = 'wrapper';
		document.body.appendChild(w);
	}
});

describe('COVID scenario site populations', () => {
	it('initializes site.pop, distinct populations, and a clean sum', async () => {
		const out: WorkerMsg[] = [];
		const sim = new WorkerSim(m => out.push(m));
		await sim.handle({
			type: 'start',
			scenario: JSON.parse(JSON.stringify(covid)),
			seed: 12345,
		});

		const started = out.find(m => m.type === 'started') as
			{ snapshot: Snapshot; bootstrap: Bootstrap } | undefined;
		expect(started).toBeTruthy();
		const snap = started!.snapshot;
		const boot = started!.bootstrap;

		expect(boot.sites).toHaveLength(1);
		expect(boot.sites[0].totalPop).toBe(10_000_000);

		const site = snap.sites[0];
		expect(site.pop).toBe(10_000_000);

		const sum = site.pops.reduce((a, p) => a + p.pop, 0);
		expect(Math.abs(sum - 10_000_000)).toBeLessThan(2);

		// No duplicate syndrome keys — pops_kv must dedupe.
		const seen = new Set<string>();
		for (const p of site.pops) {
			expect(seen.has(p.syndromeKey)).toBe(false);
			seen.add(p.syndromeKey);
		}
	});

	it('emits both world-aggregate and per-site histories for trait trackers', async () => {
		// Regression test for: trait trackers displayed as 0 because the
		// worker only emitted `world.trait_hist` (the combined sum across
		// sites) and never the per-site `site.trait_hist`. The GUI uses the
		// per-site one in site view and the combined one in world view —
		// both must be on the wire.
		const out: WorkerMsg[] = [];
		const sim = new WorkerSim(m => out.push(m));
		await sim.handle({
			type: 'start',
			scenario: JSON.parse(JSON.stringify(covid)),
			seed: 12345,
		});
		const started = out.find(m => m.type === 'started') as
			{ snapshot: Snapshot; bootstrap: Bootstrap } | undefined;
		const boot = started!.bootstrap;
		const snap = started!.snapshot;

		const traits = boot.trackers.filter(t => t.type === 'trait');
		expect(traits.length).toBeGreaterThan(0);
		// Traits remain non-global — they have both per-site histories
		// AND a combined world-level aggregate.
		for (const t of traits) expect(t.global).toBe(false);

		// For at least one trait we expect a delta with no siteKey
		// (combined) AND a delta with siteKey (per-site).
		const aliveDeltas = snap.historyDelta.filter(d => d.trackerId === 'trait:alive');
		expect(aliveDeltas.some(d => d.siteKey === undefined)).toBe(true);
		expect(aliveDeltas.some(d => d.siteKey !== undefined)).toBe(true);

		// In a single-site scenario the combined and per-site values for
		// the only site should agree exactly.
		const combined = aliveDeltas.find(d => d.siteKey === undefined)!;
		const perSite = aliveDeltas.find(d => d.siteKey === boot.sites[0].key)!;
		expect(combined.values).toEqual(perSite.values);
	});

	it('progresses infections + deaths across days', async () => {
		// Regression: caught the GPU-pipeline storage-buffer cap bug where
		// applyShed produced 0 hits and transmissions never propagated. If
		// `trait:infected` ever stops moving in 30 simulated days, this fires.
		const out: WorkerMsg[] = [];
		const sim = new WorkerSim(m => out.push(m));
		await sim.handle({
			type: 'start',
			scenario: JSON.parse(JSON.stringify(covid)),
			seed: 12345,
		});
		await sim.handle({ type: 'step', count: 30 });

		const last = out[out.length - 1] as { snapshot: Snapshot };
		expect(last.snapshot.age).toBe(31);

		// Build full per-tracker series by replaying every snapshot's deltas.
		const series = new Map<string, number[]>();
		for (const m of out) {
			if (m.type !== 'started' && m.type !== 'snapshot') continue;
			for (const d of m.snapshot.historyDelta) {
				if (d.siteKey !== undefined) continue; // world aggregate only
				const cur = series.get(d.trackerId) ?? [];
				while (cur.length < d.startDay) cur.push(0);
				cur.length = d.startDay;
				for (const v of d.values) cur.push(v);
				series.set(d.trackerId, cur);
			}
		}

		// Hard assertion: by day 30 we expect at least some infections,
		// hospitalized cases, and at least one dead person.
		const probe = (id: string) => series.get(id) ?? [];
		const infectedMax = Math.max(0, ...probe('trait:infected'));
		const deadMax = Math.max(0, ...probe('trait:dead'));
		const hospMax = Math.max(0, ...probe('trait:hospitalized'));
		expect(infectedMax).toBeGreaterThan(0);
		expect(deadMax).toBeGreaterThan(0);
		expect(hospMax).toBeGreaterThan(0);

		// Bootstrap meta must include the trackers the GUI looks up.
		const startedMsg = out.find(m => m.type === 'started') as
			{ bootstrap: Bootstrap } | undefined;
		const ids = new Set(startedMsg!.bootstrap.trackers.map(t => t.id));
		expect(ids.has('trait:infected')).toBe(true);
		expect(ids.has('trait:dead')).toBe(true);
		expect(ids.has('trait:hospitalized')).toBe(true);
	});
});

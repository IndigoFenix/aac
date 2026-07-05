/**
 * State signal smoke tests:
 *   - History deltas accumulate across snapshots without dropping data.
 *   - Hidden-series flag round-trips.
 *   - Auto news with body parks an entry into activeModalNews; ticker-only
 *     news does not.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
	bootstrap, snap, ui, applyHistoryDeltas, getSeries, clearSeries,
	toggleSeries, isSeriesHidden, pushNews, activeModalNews, dismissModalNews,
	updateUi, setBootstrap, setSnapshot,
} from '../state';

beforeEach(() => {
	bootstrap.value = null;
	snap.value = null;
	clearSeries();
	updateUi({ hiddenSeries: {} });
	dismissModalNews();
});

describe('history accumulation', () => {
	it('appends new days from successive deltas', () => {
		applyHistoryDeltas([{ trackerId: 't1', startDay: 0, values: [1, 2, 3] }]);
		expect(getSeries('t1')?.values).toEqual([1, 2, 3]);
		applyHistoryDeltas([{ trackerId: 't1', startDay: 3, values: [4, 5] }]);
		expect(getSeries('t1')?.values).toEqual([1, 2, 3, 4, 5]);
	});

	it('handles overlap by replacing from the overlap point', () => {
		applyHistoryDeltas([{ trackerId: 't1', startDay: 0, values: [1, 2, 3] }]);
		applyHistoryDeltas([{ trackerId: 't1', startDay: 2, values: [99, 100] }]);
		expect(getSeries('t1')?.values).toEqual([1, 2, 99, 100]);
	});

	it('keeps per-site series independent', () => {
		applyHistoryDeltas([
			{ trackerId: 't1', siteKey: 'a', startDay: 0, values: [10] },
			{ trackerId: 't1', siteKey: 'b', startDay: 0, values: [20] },
		]);
		expect(getSeries('t1', 'a')?.values).toEqual([10]);
		expect(getSeries('t1', 'b')?.values).toEqual([20]);
	});
});

describe('hidden series', () => {
	it('round-trips toggle for global trackers', () => {
		expect(isSeriesHidden('t1')).toBe(false);
		toggleSeries('t1');
		expect(isSeriesHidden('t1')).toBe(true);
		toggleSeries('t1');
		expect(isSeriesHidden('t1')).toBe(false);
	});

	it('keeps site-specific hides independent', () => {
		toggleSeries('t1', 'a');
		expect(isSeriesHidden('t1', 'a')).toBe(true);
		expect(isSeriesHidden('t1', 'b')).toBe(false);
		expect(isSeriesHidden('t1')).toBe(false);
	});
});

describe('news pause-on-modal rule', () => {
	it('parks auto news with body into the modal slot', () => {
		pushNews([{
			id: 'n1', day: 1, title: 'Outbreak', body: 'Fifty cases reported.', siteKey: null, auto: true,
		}]);
		expect(activeModalNews.value?.id).toBe('n1');
	});

	it('does not park ticker-only auto news (empty body)', () => {
		pushNews([{
			id: 'n2', day: 1, title: 'Daily report', body: '', siteKey: null, auto: true,
		}]);
		expect(activeModalNews.value).toBeNull();
	});

	it('does not park non-auto news even with a body', () => {
		pushNews([{
			id: 'n3', day: 1, title: 'Routine', body: 'A note.', siteKey: null, auto: false,
		}]);
		expect(activeModalNews.value).toBeNull();
	});
});

describe('setSnapshot integration', () => {
	it('grows the series and surfaces pause-requested', () => {
		setBootstrap({
			scenarioKey: 'k', scenarioName: 'k',
			sites: [{ key: 's', name: 's', totalPop: 0 }],
			guiGroups: [], trackers: [], actions: [], stockpiles: [], phases: [], useDate: false, startDate: '', dayString: 'Day',
		});
		setSnapshot({
			age: 1,
			sites: [{ key: 's', pop: 10, pops: [] }],
			historyDelta: [{ trackerId: 't', startDay: 0, values: [5] }],
			news: [{ id: 'auto', day: 1, title: 'Bad news', body: 'Details.', siteKey: null, auto: true }],
			actions: [],
			stockpiles: [],
			hiddenTrackerIds: [],
			grayedOutTrackerIds: [],
			pauseRequested: true,
		});
		expect(getSeries('t')?.values).toEqual([5]);
		expect(snap.value?.pauseRequested).toBe(true);
		expect(activeModalNews.value?.id).toBe('auto');
	});

	it('keeps just-applied series when bootstrap arrives a tick later', () => {
		// Reproduction of the late-mount race: the snapshot listener fires
		// (or replays) first, populating the seriesMap with day-0 deltas;
		// then the bootstrap listener fires (or replays). If `setBootstrap`
		// were to clear series, every tracker would read 0 in the GUI even
		// though the worker delivered the right data.
		setSnapshot({
			age: 1,
			sites: [{ key: 's', pop: 100, pops: [] }],
			historyDelta: [{ trackerId: 'trait:infected', startDay: 0, values: [9] }],
			news: [],
			actions: [],
			stockpiles: [],
			hiddenTrackerIds: [],
			grayedOutTrackerIds: [],
			pauseRequested: false,
		});
		expect(getSeries('trait:infected')?.values).toEqual([9]);

		setBootstrap({
			scenarioKey: 'k', scenarioName: 'k',
			sites: [{ key: 's', name: 's', totalPop: 100 }],
			guiGroups: [], trackers: [], actions: [], stockpiles: [], phases: [], useDate: false, startDate: '', dayString: 'Day',
		});
		// The series must survive setBootstrap.
		expect(getSeries('trait:infected')?.values).toEqual([9]);
	});
});

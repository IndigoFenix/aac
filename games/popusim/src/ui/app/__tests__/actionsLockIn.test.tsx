/**
 * Verifies the *visible* lock-in semantics on the action panel:
 *   - moving a slider only updates `desired_value`
 *   - the displayed `current_value` is whatever the worker last reported
 *   - the SimClient receives a `setActionDesired` (not a value-write) call
 *
 * This is a behavioral check on the contract — the actual day-rollover lock-in
 * lives in the worker and is exercised by simulation tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/preact';
import { ActionsPanel } from '../components/ActionsPanel';
import { setBootstrap, setSnapshot, updateUi, ui } from '../state';

function fakeClient() {
	return {
		setActionDesired: vi.fn(),
		scheduleAction: vi.fn(),
		cancelScheduled: vi.fn(),
	};
}

beforeEach(() => {
	updateUi({ collapsedGroups: {} });
});

describe('ActionsPanel lock-in', () => {
	it('shows current and desired values separately and posts setActionDesired on change', () => {
		setBootstrap({
			scenarioKey: 'k', scenarioName: 'k',
			sites: [{ key: 's1', name: 'S1', totalPop: 100 }],
			guiGroups: [],
			trackers: [],
			actions: [{
				id: 'a1', name: 'Vaccinate', groupKey: null, siteKey: null,
				type: 'slider', min: 0, max: 100, step: 1, costSummary: '', produceSummary: '', costs: [], produces: [],
			}],
			stockpiles: [],
			phases: [],
			useDate: false,
			startDate: '',
			dayString: 'Day',
		});
		setSnapshot({
			age: 5,
			sites: [{ key: 's1', pop: 100, pops: [] }],
			historyDelta: [],
			news: [],
			actions: [{
				id: 'a1', siteKey: null,
				desiredValue: 30, currentValue: 10,
				costCappedValue: null, hidden: false, disabled: false,
				disabledReason: null, schedule: [],
			}],
			stockpiles: [],
			hiddenTrackerIds: [],
			grayedOutTrackerIds: [],
			pauseRequested: false,
		});

		const client = fakeClient() as unknown as Parameters<typeof ActionsPanel>[0]['client'];
		const { container, getAllByText } = render(<ActionsPanel client={client} />);

		// Both values rendered.
		expect(getAllByText(/Currently 10/i)).not.toHaveLength(0);
		expect(getAllByText(/Set to 30/i)).not.toHaveLength(0);

		// Move the slider — should call setActionDesired, not mutate snapshot.
		const slider = container.querySelector('input[type="range"]') as HTMLInputElement;
		expect(slider).toBeTruthy();
		(slider as HTMLInputElement).value = '60';
		fireEvent.input(slider);
		expect((client as unknown as { setActionDesired: ReturnType<typeof vi.fn> }).setActionDesired)
			.toHaveBeenCalledWith('a1', null, 60);

		// Current value still 10 in the DOM (lock-in hasn't happened — that
		// only changes when a new snapshot arrives).
		expect(getAllByText(/Currently 10/i)).not.toHaveLength(0);
	});

	it('renders a HIDDEN badge only when ?showHidden is set', () => {
		// In this jsdom the search string is empty, so hidden actions should be
		// filtered out entirely.
		setBootstrap({
			scenarioKey: 'k', scenarioName: 'k',
			sites: [{ key: 's1', name: 'S1', totalPop: 0 }],
			guiGroups: [],
			trackers: [],
			actions: [{
				id: 'secret', name: 'Secret', groupKey: null, siteKey: null,
				type: 'toggle', min: 0, max: 1, step: 1, costSummary: '', produceSummary: '', costs: [], produces: [],
			}],
			stockpiles: [],
			phases: [],
			useDate: false,
			startDate: '',
			dayString: 'Day',
		});
		setSnapshot({
			age: 1,
			sites: [{ key: 's1', pop: 0, pops: [] }],
			historyDelta: [],
			news: [],
			actions: [{
				id: 'secret', siteKey: null, desiredValue: 0, currentValue: 0,
				costCappedValue: null, hidden: true, disabled: false,
				disabledReason: null, schedule: [],
			}],
			stockpiles: [],
			hiddenTrackerIds: [],
			grayedOutTrackerIds: [],
			pauseRequested: false,
		});
		const client = fakeClient() as unknown as Parameters<typeof ActionsPanel>[0]['client'];
		const { queryByText } = render(<ActionsPanel client={client} />);
		// Action title should not appear because it's hidden.
		expect(queryByText('Secret')).toBeNull();
	});
});

describe('hidden vs disabled distinction', () => {
	it('shows a disabled action greyed out with reason', () => {
		setBootstrap({
			scenarioKey: 'k', scenarioName: 'k',
			sites: [{ key: 's1', name: 'S1', totalPop: 0 }],
			guiGroups: [],
			trackers: [],
			actions: [{
				id: 'a2', name: 'Quarantine', groupKey: null, siteKey: null,
				type: 'toggle', min: 0, max: 1, step: 1, costSummary: '', produceSummary: '', costs: [], produces: [],
			}],
			stockpiles: [],
			phases: [],
			useDate: false,
			startDate: '',
			dayString: 'Day',
		});
		setSnapshot({
			age: 1,
			sites: [{ key: 's1', pop: 0, pops: [] }],
			historyDelta: [],
			news: [],
			actions: [{
				id: 'a2', siteKey: null, desiredValue: 0, currentValue: 0,
				costCappedValue: null, hidden: false, disabled: true,
				disabledReason: 'Awaiting authority approval', schedule: [],
			}],
			stockpiles: [],
			hiddenTrackerIds: [],
			grayedOutTrackerIds: [],
			pauseRequested: false,
		});
		const client = fakeClient() as unknown as Parameters<typeof ActionsPanel>[0]['client'];
		const { getByText } = render(<ActionsPanel client={client} />);
		expect(getByText('Quarantine')).toBeTruthy();
		expect(getByText(/Awaiting authority approval/)).toBeTruthy();
	});
});

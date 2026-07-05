/**
 * Browser entry point.
 *
 * Boots the Preact gameplay GUI and the SimClient (which spawns the worker).
 * The simulation runs client-side in the worker; the main thread is a thin
 * observer + UI host. Available scenarios come from `src/scenarios`; the
 * default boots immediately, and the in-app selector resets the world to
 * any other entry.
 */

import { render, h } from 'preact';
import { SimClient } from './sim/SimClient';
import { App } from './ui/app/App';
import './ui/app/styles/theme.css';
import { BUNDLED_SCENARIOS, DEFAULT_SCENARIO_KEY, findScenario, cloneScenario } from './scenarios';

const SEED = 12345;

const initialEntry = findScenario(DEFAULT_SCENARIO_KEY) ?? BUNDLED_SCENARIOS[0];
const liveScenario = cloneScenario(initialEntry);
const client = new SimClient();
// Expose for the browser console — useful for ad-hoc toggles (`__sim.setProfiler(true)`,
// `__sim.setUseGpu(false)`, etc.) without having to navigate the worker pane.
(globalThis as { __sim?: SimClient }).__sim = client;
client.start(liveScenario, SEED).catch(err => {
	console.error('SimClient.start failed', err);
});

const root = document.getElementById('app-root');
if (!root) {
	throw new Error('app-root element not found in index.html');
}
render(h(App, {
	client,
	seed: SEED,
	initialScenario: liveScenario,
	scenarios: BUNDLED_SCENARIOS,
	initialScenarioKey: initialEntry.key,
}), root);

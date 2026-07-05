/**
 * App — root of the gameplay GUI.
 *
 * Mounts on `<div id="app-root">` from `index.html`. Owns nothing simulation-
 * related directly; it observes a SimClient passed in from main.ts and dispatches
 * commands back through it. All simulation state lives behind `state.ts` signals.
 *
 * Pause-on-modal-news rule (per user decision):
 *   - News items with `auto: true` AND a non-empty body open a modal AND pause.
 *   - News items with empty body never pause; they only fill the ticker.
 *   - Implemented by: workerSim sets `pauseRequested` on the Snapshot, and on
 *     receipt App pauses + parks an entry into `activeModalNews`. The user
 *     dismisses to resume control.
 */

import { useEffect, useState } from 'preact/hooks';
import { effect } from '@preact/signals';
import {
	bootstrap, snap, ui, setSnapshot, setBootstrap, activeModalNews, updateUi,
	resetSimState,
} from './state';
import { SpeedControls } from './components/SpeedControls';
import { DatePanel } from './components/DatePanel';
import { SiteSelector } from './components/SiteSelector';
import { GraphPanel } from './components/GraphPanel';
import { NewsTicker } from './components/NewsTicker';
import { NewsFeed } from './components/NewsFeed';
import { NewsModal } from './components/NewsModal';
import { GroupedPanel } from './components/GroupedPanel';
import { WorldView } from './components/WorldView';
import { SettingsModal } from './components/SettingsModal';
import { PopulationsList } from './components/PopulationsList';
import { EditorApp, ensureDraftLoaded } from '../editor/EditorApp';
import { draft as editorDraft, setDraft as setEditorDraft } from '../editor/state';
import type { SimClient } from '../../sim/SimClient';
import type { ScenarioEntry } from '../../scenarios';
import { cloneScenario, findScenario } from '../../scenarios';

interface Props {
	client: SimClient;
	seed: number;
	/** The scenario JSON that was last handed to the SimClient. Used to
	 * seed the editor draft when the user opens it for the first time. */
	initialScenario: Record<string, unknown>;
	/** Bundled scenarios for the top-bar switcher. */
	scenarios: readonly ScenarioEntry[];
	/** Key of the scenario currently running. */
	initialScenarioKey: string;
}

export function App({ client, seed, initialScenario, scenarios, initialScenarioKey }: Props) {
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [liveScenario, setLiveScenario] = useState<Record<string, unknown>>(initialScenario);
	const [activeScenarioKey, setActiveScenarioKey] = useState<string>(initialScenarioKey);

	// Wire the SimClient into our signals.
	useEffect(() => {
		const offSnap = client.subscribe(s => setSnapshot(s));
		const offBoot = client.onBootstrap(b => setBootstrap(b));
		// React to pause-requested news.
		const stop = effect(() => {
			const s = snap.value;
			if (s && s.pauseRequested && ui.value.speed !== 'paused') {
				updateUi({ speed: 'paused' });
				void client.pause();
			}
		});
		return () => { offSnap(); offBoot(); stop(); };
	}, [client]);

	// Reflect language/dir on <html>.
	useEffect(() => {
		document.documentElement.dir = ui.value.dir;
		document.documentElement.lang = ui.value.language;
	});

	const view = ui.value.view;
	const ready = !!bootstrap.value;
	const mode = ui.value.mode;

	if (mode === 'editor') {
		return <EditorApp client={client} seed={seed} onStarted={setLiveScenario} />;
	}

	async function onReset() {
		// Clone the original scenario so the next run starts from a pristine
		// copy — World mutates the data object during start.
		const fresh = JSON.parse(JSON.stringify(liveScenario)) as Record<string, unknown>;
		setLiveScenario(fresh);
		resetSimState();
		try {
			await client.reset(fresh, seed);
		} catch (err) {
			console.error('Reset failed', err);
		}
	}

	async function onSwitchScenario(key: string): Promise<void> {
		const entry = findScenario(key);
		if (!entry || key === activeScenarioKey) return;
		const fresh = cloneScenario(entry);
		setLiveScenario(fresh);
		setActiveScenarioKey(key);
		resetSimState();
		try {
			await client.reset(fresh, seed);
		} catch (err) {
			console.error('Scenario switch failed', err);
		}
	}

	function toggleDebug() {
		updateUi({ debugView: !ui.value.debugView });
	}

	function openEditor() {
		// Per CLAUDE.md, the world should not exist while the editor is open.
		// Tear down the worker's World/System entirely; hitting Start boots
		// a fresh world from the draft. Avoids any state carryover that
		// could otherwise corrupt the next run (history accumulators,
		// scheduled actions, in-flight sheds, etc.).
		void client.shutdown().catch(err => {
			console.error('Failed to shut down simulation worker:', err);
		});
		// Seed the editor draft from a persisted draft if one exists; otherwise
		// from the scenario the SimClient was last started with.
		ensureDraftLoaded();
		if (editorDraft.value === null) {
			setEditorDraft(JSON.parse(JSON.stringify(liveScenario)) as Record<string, unknown>);
		}
		updateUi({ speed: 'paused', mode: 'editor' });
	}

	return (
		<div class="app" data-reduce-motion={ui.value.reduceMotion ? 'true' : 'false'}>
			<header class="top-bar">
				<DatePanel />
				<SiteSelector />
				<ScenarioSelector
					scenarios={scenarios}
					activeKey={activeScenarioKey}
					onSwitch={onSwitchScenario}
				/>
				<SpeedControls client={client} />
				<button onClick={onReset} title="Reset the simulation to its initial state">↺ Reset</button>
				<button
					onClick={toggleDebug}
					class={ui.value.debugView ? 'primary' : ''}
					title="Show populations-by-syndrome list instead of the news feed"
					aria-pressed={ui.value.debugView}
				>🛠 Debug</button>
				<div class="top-bar-spacer" />
				<GpuIndicator client={client} />
				<button onClick={openEditor} title="Open the scenario editor">Edit Scenario</button>
				<button onClick={() => setSettingsOpen(true)}>⚙</button>
			</header>
			{!ready ? <div style="padding: 1.5rem">Loading scenario…</div> : (
				<main class="app-main">
					<div class="center-col">
						<NewsTicker onExpandClick={() => updateUi({ view: view === 'world' ? 'site' : 'world' })} />
						{view === 'world' ? <WorldView /> : <GraphPanel />}
						{ui.value.debugView ? <PopulationsList /> : <NewsFeed />}
					</div>
					<div class="right-rail">
						<GroupedPanel client={client} />
					</div>
				</main>
			)}
			<NewsModal />
			<SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} client={client} />
		</div>
	);
}

function ScenarioSelector(
	{ scenarios, activeKey, onSwitch }:
		{ scenarios: readonly ScenarioEntry[]; activeKey: string; onSwitch: (key: string) => void },
) {
	if (scenarios.length <= 1) return null;
	return (
		<select
			class="scenario-selector"
			value={activeKey}
			onChange={(e) => onSwitch((e.currentTarget as HTMLSelectElement).value)}
			title="Switch scenario"
		>
			{scenarios.map(s => (
				<option key={s.key} value={s.key}>{s.name}</option>
			))}
		</select>
	);
}

function GpuIndicator({ client }: { client: SimClient }) {
	const [, setT] = useState(0);
	useEffect(() => {
		const id = setInterval(() => setT(n => n + 1), 1500);
		return () => clearInterval(id);
	}, []);
	const available = client.gpuAvailable();
	const active = client.gpuActive();
	const label = !available ? 'GPU: unavailable' : active ? 'GPU: active' : 'GPU: disabled';
	const color = !available ? 'var(--warn)' : active ? 'var(--ok)' : 'var(--fg-muted)';
	return <span class="gpu-indicator" style={`color: ${color}`}>{label}</span>;
}

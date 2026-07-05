/**
 * WorkerSim — the protocol-handling kernel of the simulation worker.
 *
 * Lives in its own module so tests can import it without pulling in the
 * worker-bootstrap glue (`self.addEventListener('message', …)`) which only
 * makes sense in a real Worker context. The actual worker entry
 * (`worker.ts`) constructs a WorkerSim and wires its `post` callback to
 * `self.postMessage`.
 *
 * One WorkerSim instance per worker: its `system` and `world` fields are
 * replaced on every `start` / `reset`. Concurrent `step` and `run`
 * messages are sequenced by JavaScript's single-threaded event loop —
 * `handle` is async but each invocation runs to completion or its first
 * `await` before the next message is dispatched.
 */

import './documentShim';
import './../wireup';
import { System } from '../controller/System';
import { World } from '../controller/World';
import type {
	ClientMsg,
	WorkerMsg,
	Snapshot,
	Bootstrap,
	HistoryDeltaSnapshot,
	NewsSnapshot,
	ActionSnapshot,
	StockpileValueSnapshot,
	ScheduledChange,
	TrackerPatch,
	TrackerMeta,
	CustomMetricSpec,
	CustomCorrelationSpec,
} from './protocol';
import { CustomMetric } from '../game/tracking/CustomMetric';
import { GpuContext } from './gpu/GpuContext';
import { ShedAmountKernel } from './gpu/shedAmountKernel';
import { SeekModKernel } from './gpu/seekModKernel';
import { ApplyShedKernel } from './gpu/applyShedKernel';
import { GpuPopState } from './gpu/GpuPopState';
import { getSubsynRegistry, type SubsynRegistryWasm } from './gpu/subsynRegistryWasm';
import { profiler } from '../core/Profiler';
import { formatClusterReport, type ClusterReport } from './clustering/ClusterDetector';
import { buildPartition, type ClusterPartition } from './clustering/ClusterPartition';
import { verifyFactorization, type FactorVerification } from './clustering/ClusterVerifier';
import { FactoredEvolver } from './clustering/FactoredEvolver';

/* --- Loose runtime shapes --- */

interface SiteRuntime {
	key: string;
	name?: string;
	pop: number;
	pops: PopRuntime[];
	trait_hist?: HistoryRuntime[];
	resource_hist_kv?: Record<string, HistoryRuntime>;
	metric_hist?: HistoryRuntime[];
	local_stockpiles?: StockpileRuntime[];
	actions?: ActionRuntime[];
	actions_kv?: Record<string, ActionInstanceRuntime>;
}
interface PopRuntime { pop: number; syndrome: { key: string } }
interface HistoryRuntime { tracker: TrackerRuntime; start: number; val: number[] }
interface TrackerRuntime {
	key: string;
	color: string;
	guigroup: { key: string } | string | null;
	type: number;
	global: boolean;
	hidden: boolean;
	graph_hidden: boolean;
	obj?: { name?: string; display?: string };
	resource?: { graph_display?: string };
	metric?: { perc?: boolean; precision?: number; grayed_out?: boolean; base_key?: string };
	trait?: { is_correlation?: boolean; grayed_out?: boolean; hidden?: boolean };
}
interface StockpileRuntime { id?: number; resource: { key: string; global: boolean; signed?: boolean; getName?: () => string }; value: number; site?: { key: string } | null }
interface ActionRuntime {
	key: string;
	name?: string;
	guigroup?: { key: string } | string | null;
	global: boolean;
	type?: 'toggle' | 'slider' | 'number' | string;
	min?: number;
	max?: number;
	step?: number;
	desired_value: number;
	current_value: number;
	cost_capped_value?: number | null;
	enabled?: boolean;
	hidden?: boolean;
	disabled_reason?: string | null;
	cost?: ActionCostRuntime[];
	produce?: ActionProduceRuntime[];
	transmit_list?: unknown[];
}
interface ActionCostRuntime {
	/** Resource key (string). The runtime ActionCost stores the original
	 * scenario reference here, separate from the resolved resource_obj. */
	resource: string;
	resource_obj?: { key: string; name?: string; getName?: () => string };
	/** Per-unit cost. Always positive — consumption. */
	value: number;
	phase_index?: number;
	stockpile?: StockpileRuntime;
}
interface ActionProduceRuntime {
	resource: string;
	resource_obj?: { key: string; name?: string; getName?: () => string };
	value: number;
	sd: number;
	phase_index?: number;
	stockpile?: StockpileRuntime;
}
interface ActionInstanceRuntime {
	enabled: boolean;
	hidden?: boolean;
	disabled_reason?: string | null;
	desired_value?: number;
	current_value?: number;
	schedule?: ScheduledChange[];
	setValue?: (v: number) => void;
}
interface NewsItemRuntime { auto?: boolean; title?: string; text?: string; siteKey?: string | null; day?: number }
interface GUIGroupRuntime { key: string; name?: string; parent?: { key: string } | string | null; index?: number }
interface IndexedPhaseRuntime { key: string; index: number }

export class WorkerSim {
	private system: System | null = null;
	private world: World | null = null;
	private running: boolean = false;
	/**
	 * Generation counter for run loops — incremented on every `start`,
	 * `reset`, or new `run` so a stale loop iteration can detect it has
	 * been superseded and bail out without sending a final paused snapshot.
	 */
	private runGen: number = 0;
	/**
	 * Promise tracking the in-flight `run` or `step` loop, if any. Every
	 * message handler that mutates simulation state (start/reset/step/run/
	 * pause/shutdown) awaits this first via `drainCurrentLoop()` so we
	 * never have two `newDay()` invocations interleaving at GPU await
	 * points — that race manifests as occasional graph spikes (some pops'
	 * deltas missed on day N, then "catch up" on day N+1) and only fires
	 * in GPU mode because the CPU path has no real awaits.
	 */
	private currentLoop: Promise<void> | null = null;
	private gpu: GpuContext | null = null;
	private shedKernel: ShedAmountKernel | null = null;
	private seekKernel: SeekModKernel | null = null;
	private applyShedKernel: ApplyShedKernel | null = null;
	private gpuPopState: GpuPopState | null = null;
	private gpuInitialized: boolean = false;
	useGpu: boolean = true;
	/** Experimental trait-clustering system (Phase C0: diagnostics only).
	 * Off by default — it has no behavioral effect yet and exists to be
	 * inspected/stress-tested for edge cases. Behavioral phases will gate on
	 * the same flag. */
	clustering: boolean = false;
	/** Last computed cluster report, or null. */
	clusterReport: ClusterReport | null = null;
	/** Runtime partition built from the current world (Phase C1). The factored
	 * storage / dynamics phases (C2+) will read this. */
	clusterPartition: ClusterPartition | null = null;
	/** Factored per-cluster evolver (Phase C2a), built on demand. Only supports
	 * independent, coupling-free clusters for now (no exit/death glue yet), so
	 * it stays null when the partition has exit coupling. The joint engine
	 * remains authoritative; this is the verified substitute-in-waiting. */
	clusterEvolver: FactoredEvolver | null = null;
	/** Boot scenario (deep copy) + seed, retained so the evolver's sub-Worlds
	 * can be projected from the same scenario the joint world was built from. */
	private bootScenario: Record<string, unknown> | null = null;
	private bootSeed: number = 0;
	/** C2-final promotion gate. While clustering is on and an evolver exists,
	 * the first `clusterWarmupDays` are run on BOTH engines and the evolver's
	 * marginals are checked against the joint. If the max residual stays under
	 * `clusterResidualThreshold`, the evolver is PROMOTED: the joint engine stops
	 * and the day loop runs the sub-Worlds alone (the cost saving). Otherwise the
	 * evolver is dropped and the joint stays authoritative (safe fallback). */
	clusterPromoted: boolean = false;
	private clusterPromotionDecided: boolean = false;
	clusterWarmupDays: number = 5;
	clusterResidualThreshold: number = 0.01;
	private clusterWarmupCount: number = 0;
	private clusterWarmupMaxResidual: number = 0;
	/** C3 dynamic re-partition (runs each day while the evolver is live). A
	 * resource-gated coupling is treated inert within `clusterGateBand` of 1;
	 * a cluster splits back only when its joint factors within `clusterSplitEps`. */
	clusterGateBand: number = 1e-6;
	clusterSplitEps: number = 2e-3;
	/** How often (in days) the factorization monitor re-verifies during a run.
	 * Verification is cheap relative to a day; 1 = every day. */
	clusterMonitorInterval: number = 1;
	/** Residual above which the monitor raises an alarm (and emits a fresh
	 * clusterReport). The detected partition should hold residual ~0 forever;
	 * a breach means a coupling crept in that the static detector missed —
	 * the standing edge-case net (Imply, future dynamic couplings, bugs). */
	clusterMonitorThreshold: number = 0.05;
	/** Rolling factorization-monitor state across the current run. */
	clusterMonitor: {
		daysChecked: number;
		lastResidual: number;
		maxResidualSeen: number;
		maxResidualDay: number;
		breaches: number;
		inBreach: boolean;
	} = { daysChecked: 0, lastResidual: 0, maxResidualSeen: 0, maxResidualDay: -1, breaches: 0, inBreach: false };
	/** WASM-backed SubSyndrome registry, lazily loaded on first boot. Stays
	 * `null` if the WASM file can't be fetched (jsdom tests, isolated CI). */
	private subsynWasm: SubsynRegistryWasm | null = null;

	/**
	 * Per-(trackerId, siteKey?) high-water-mark of the day count we've already
	 * shipped. Used to send only the new tail in `historyDelta`.
	 */
	private historySent = new Map<string, number>();
	/** Queued news items the worker hasn't shipped yet. */
	private pendingNews: NewsSnapshot[] = [];
	private newsCounter: number = 0;
	/** Schedule maps populated by `scheduleAction` — keyed
	 * `${actionId}|${siteKey ?? ''}`. */
	private schedules = new Map<string, ScheduledChange[]>();

	/**
	 * Player-side custom metrics & correlations, kept across resets so a
	 * /reset of the same scenario preserves what the player built. Cleared on
	 * shutdown and on a `start` whose scenarioKey doesn't match the cached
	 * one. Mirrors legacy `custom_metrics_prev` / `custom_traits_prev`
	 * (script.js:3208-3242).
	 */
	private playerCustomMetrics: CustomMetric[] = [];
	private playerCustomCorrelations: Array<{ kind: 'correlation'; key: string; data: Record<string, unknown> }> = [];
	/**
	 * Original create/edit specs, keyed by base_key. Shipped to the client via
	 * trackerMeta so the UI can render the formula for unnamed metrics and
	 * pre-populate the edit modal. Wiped on shutdown / scenario switch
	 * alongside the runtime arrays above.
	 */
	private playerMetricSpecs = new Map<string, CustomMetricSpec>();
	private playerCorrelationSpecs = new Map<string, CustomCorrelationSpec>();
	private playerScenarioKey: string | null = null;
	/** Pending tracker-patch entries to attach to the next snapshot. */
	private pendingTrackerPatch: TrackerPatch | null = null;

	constructor(private readonly post: (msg: WorkerMsg) => void) { }

	async handle(msg: ClientMsg): Promise<void> {
		switch (msg.type) {
			case 'start':
			case 'reset':
				await this.boot(msg.scenario, msg.seed);
				this.post({
					type: 'started',
					snapshot: this.snapshot(),
					bootstrap: this.bootstrap(),
					gpuAvailable: this.gpu !== null,
					gpuActive: this.useGpu && this.gpu !== null,
				});
				return;
			case 'setUseGpu':
				this.useGpu = msg.enabled;
				if (this.world) {
					const w = this.world as unknown as {
						shedAmountKernel: ShedAmountKernel | null;
						seekModKernel: SeekModKernel | null;
						applyShedKernel: ApplyShedKernel | null;
					};
					w.shedAmountKernel = this.useGpu ? this.shedKernel : null;
					w.seekModKernel = this.useGpu ? this.seekKernel : null;
					w.applyShedKernel = this.useGpu ? this.applyShedKernel : null;
				}
				return;
			case 'setProfiler':
				if (msg.enabled) profiler.enable();
				else profiler.disable();
				return;
			case 'setClustering':
				this.clustering = msg.enabled;
				if (this.clustering && this.world) this.computeAndPostClusters();
				else if (!this.clustering) {
					this.clusterReport = null;
					this.clusterPartition = null;
					this.clusterEvolver?.destroy();
					this.clusterEvolver = null;
				}
				return;
			case 'step': {
				await this.drainCurrentLoop();
				const w = this.requireWorld();
				const loop = (async () => {
					for (let i = 0; i < msg.count; i++) {
						this.applyScheduledChanges();
						await this.advanceDay();
					}
					this.post({ type: 'snapshot', snapshot: this.snapshot() });
				})();
				this.currentLoop = loop;
				try { await loop; }
				finally { if (this.currentLoop === loop) this.currentLoop = null; }
				return;
			}
			case 'run': {
				await this.drainCurrentLoop();
				this.running = true;
				const gen = ++this.runGen;
				const w = this.requireWorld();
				const ms = Math.max(0, msg.msPerDay | 0);
				const snapEvery = Math.max(1, msg.snapshotEveryDays | 0);
				const loop = (async () => {
					let i = 0;
					while (this.running && gen === this.runGen) {
						this.applyScheduledChanges();
						const tStart = performance.now();
						await this.advanceDay();
						i++;
						if (i % snapEvery === 0) {
							this.post({ type: 'snapshot', snapshot: this.snapshot() });
						}
						// Throttle to msPerDay if positive. We *subtract* the time
						// the day itself took so the wall-clock cadence stays
						// honest at slow speeds — at 1 s/day a 50 ms newDay
						// shouldn't push the next tick to 1.05 s.
						if (ms > 0) {
							const elapsed = performance.now() - tStart;
							const wait = Math.max(0, ms - elapsed);
							await new Promise<void>(r => setTimeout(r, wait));
						} else {
							// Still yield to the macrotask queue so pause messages
							// can land — without this, max-speed runs are
							// uninterruptible.
							await new Promise<void>(r => setTimeout(r, 0));
						}
					}
					if (gen === this.runGen) {
						this.post({ type: 'paused', snapshot: this.snapshot() });
					}
				})();
				this.currentLoop = loop;
				try { await loop; }
				finally { if (this.currentLoop === loop) this.currentLoop = null; }
				return;
			}
			case 'pause': {
				const wasRunning = this.running;
				this.running = false;
				// Wait for the in-flight loop iteration to finish before
				// returning, so the caller's `await client.pause()` doesn't
				// race with the loop's last newDay. The loop itself emits
				// `paused` once it exits cleanly.
				if (this.currentLoop !== null) {
					try { await this.currentLoop; }
					catch { /* swallow — pausing anyway */ }
				}
				if (!wasRunning) {
					this.post({ type: 'paused', snapshot: this.snapshot() });
				}
				return;
			}
			case 'shutdown':
				await this.drainCurrentLoop();
				this.teardown();
				this.post({ type: 'shutdown_done' });
				return;
			case 'setActionDesired':
				this.setActionDesired(msg.actionId, msg.siteKey, msg.value);
				return;
			case 'scheduleAction':
				this.scheduleAction(msg.actionId, msg.siteKey, msg.day, msg.value);
				return;
			case 'cancelScheduled':
				this.cancelScheduled(msg.actionId, msg.siteKey, msg.day);
				return;
			case 'addCustomMetric':
				this.addCustomMetricFromSpec(msg.spec);
				this.post({ type: 'snapshot', snapshot: this.snapshot() });
				return;
			case 'removeCustomMetric':
				this.removePlayerMetric(msg.metricBaseKey);
				this.post({ type: 'snapshot', snapshot: this.snapshot() });
				return;
			case 'addCorrelation':
				this.addCorrelationFromSpec(msg.spec);
				this.post({ type: 'snapshot', snapshot: this.snapshot() });
				return;
			case 'removeCustomTrait':
				this.removePlayerCorrelation(msg.traitBaseKey);
				this.post({ type: 'snapshot', snapshot: this.snapshot() });
				return;
			case 'editCustomMetric':
				this.editCustomMetricFromSpec(msg.metricBaseKey, msg.spec);
				this.post({ type: 'snapshot', snapshot: this.snapshot() });
				return;
			case 'editCorrelation':
				this.editCorrelationFromSpec(msg.traitBaseKey, msg.spec);
				this.post({ type: 'snapshot', snapshot: this.snapshot() });
				return;
		}
	}

	/* --------------------- Player-side metrics & correlations --------------------- */

	private addCustomMetricFromSpec(spec: CustomMetricSpec, options?: { forceBaseKey?: string }): void {
		const w = this.world as unknown as {
			addMetric: (m: CustomMetric, opts?: { forceBaseKey?: string }) => CustomMetric;
			trackers: TrackerRuntime[];
			metric_trackers_kv: Record<string, TrackerRuntime>;
		} | null;
		if (!w) return;
		const metric = new CustomMetric(this.world as never, {
			name: spec.name,
			color: spec.color,
			perc: spec.perc ? 1 : 0,
			precision: spec.precision,
			expression_data: spec.expressionData,
		});
		w.addMetric(metric, options);
		this.playerCustomMetrics.push(metric);
		this.playerMetricSpecs.set(metric.base_key, spec);
		// Patch: emit the new tracker so the UI can register it without waiting
		// for a fresh Bootstrap.
		const tracker = w.metric_trackers_kv[metric.base_key];
		if (tracker) {
			this.queueTrackerPatch({ added: [this.trackerMeta(tracker)], removedIds: [] });
		}
	}

	private addCorrelationFromSpec(spec: CustomCorrelationSpec, options?: { forceKey?: string }): void {
		const w = this.world as unknown as {
			addCorrelationTrait: (data: Record<string, unknown>, opts?: { forceKey?: string }) => { base_key: string };
			trait_trackers_kv: Record<string, TrackerRuntime>;
		} | null;
		if (!w) return;
		const data = {
			name: spec.name,
			color: spec.color,
			guigroup: spec.guigroup,
			def_and: spec.def_and,
			def_not: spec.def_not,
			def_or: spec.def_or,
			require: spec.require,
			forbid: spec.forbid,
		} as Record<string, unknown>;
		const trait = w.addCorrelationTrait(data, options);
		this.playerCustomCorrelations.push({ kind: 'correlation', key: trait.base_key, data });
		this.playerCorrelationSpecs.set(trait.base_key, spec);
		const tracker = w.trait_trackers_kv[trait.base_key];
		if (tracker) {
			this.queueTrackerPatch({ added: [this.trackerMeta(tracker)], removedIds: [] });
		}
	}

	private removePlayerMetric(baseKey: string): void {
		const w = this.world as unknown as {
			custom_metrics: Array<{ base_key: string }>;
			removeCustomMetric: (m: unknown) => void;
		} | null;
		if (!w) return;
		const metric = w.custom_metrics.find(m => m.base_key === baseKey);
		if (!metric) return;
		w.removeCustomMetric(metric);
		this.playerCustomMetrics = this.playerCustomMetrics.filter(m => m.base_key !== baseKey);
		this.playerMetricSpecs.delete(baseKey);
		this.queueTrackerPatch({ added: [], removedIds: [`metric:${baseKey}`] });
	}

	private removePlayerCorrelation(baseKey: string): void {
		const w = this.world as unknown as {
			traits_kv: Record<string, { base_key: string; is_correlation?: boolean }>;
			removeCustomTrait: (t: unknown) => void;
		} | null;
		if (!w) return;
		const trait = w.traits_kv[baseKey];
		if (!trait || !trait.is_correlation) return;
		w.removeCustomTrait(trait);
		this.playerCustomCorrelations = this.playerCustomCorrelations.filter(c => c.key !== baseKey);
		this.playerCorrelationSpecs.delete(baseKey);
		this.queueTrackerPatch({ added: [], removedIds: [`trait:${baseKey}`] });
	}

	/**
	 * Edit a player-created metric in place: drop the existing one and
	 * re-create it under the same `base_key`. The reverse-index of metrics
	 * that referenced the old metric continues to resolve to the new one
	 * because expression_data references trackers by `metric:${baseKey}` —
	 * a string that doesn't change across the swap.
	 */
	private editCustomMetricFromSpec(baseKey: string, spec: CustomMetricSpec): void {
		const w = this.world as unknown as {
			custom_metrics: Array<{ base_key: string }>;
		} | null;
		if (!w) return;
		const exists = w.custom_metrics.some(m => m.base_key === baseKey);
		if (!exists) {
			// Nothing to edit — fall back to a fresh add so we don't drop the user's work.
			this.addCustomMetricFromSpec(spec);
			return;
		}
		this.removePlayerMetric(baseKey);
		this.addCustomMetricFromSpec(spec, { forceBaseKey: baseKey });
	}

	/**
	 * Edit a player-created correlation in place. Caveat: removing a
	 * correlation does NOT retroactively remove it from syndromes that
	 * already include it (see `World.removeCustomTrait`). The new tracker
	 * and history reflect the new definition, but populations that were
	 * already classified under the old definition keep that classification
	 * for the rest of the run.
	 */
	private editCorrelationFromSpec(baseKey: string, spec: CustomCorrelationSpec): void {
		const w = this.world as unknown as {
			traits_kv: Record<string, { base_key: string; is_correlation?: boolean }>;
		} | null;
		if (!w) return;
		const trait = w.traits_kv[baseKey];
		if (!trait || !trait.is_correlation) {
			this.addCorrelationFromSpec(spec);
			return;
		}
		this.removePlayerCorrelation(baseKey);
		this.addCorrelationFromSpec(spec, { forceKey: baseKey });
	}

	private queueTrackerPatch(patch: TrackerPatch): void {
		if (!this.pendingTrackerPatch) {
			this.pendingTrackerPatch = { added: [], removedIds: [] };
		}
		this.pendingTrackerPatch.added.push(...patch.added);
		this.pendingTrackerPatch.removedIds.push(...patch.removedIds);
	}

	/**
	 * Stop the current run/step loop (if any) and wait for its last
	 * `newDay()` to complete. Every message handler that mutates simulation
	 * state must call this first, otherwise a new handler's `newDay()` can
	 * start while the previous one is still awaiting a GPU dispatch, and
	 * the two run concurrently — they interleave at await points and
	 * corrupt the world's pop counts.
	 */
	private async drainCurrentLoop(): Promise<void> {
		const loop = this.currentLoop;
		if (loop === null) return;
		this.running = false;
		// Bump runGen so even if the loop is already past the `running`
		// check, the next iteration's gen-check exits it.
		this.runGen++;
		try { await loop; } catch { /* tearing down, ignore */ }
		if (this.currentLoop === loop) this.currentLoop = null;
	}

	/**
	 * Drop the current World/System and any in-flight loop. Idempotent —
	 * safe to call when there's no world. Used by `boot()` to ensure no
	 * cross-world state leaks (event listeners, history accumulators,
	 * pending sheds), and exposed via the `shutdown` message so the
	 * editor can hand the worker an "empty" state while editing.
	 *
	 * GPU kernels and the GpuContext survive teardown — they're stateless
	 * with respect to the World and expensive to recreate.
	 */
	private teardown(): void {
		this.running = false;
		this.runGen++;
		if (this.world) {
			try {
				(this.world as unknown as { destroy(): void }).destroy();
			} catch {
				// Some destroy paths reach into UI code that doesn't exist in
				// the worker. Swallow — we're tearing down anyway.
			}
		}
		this.world = null;
		this.system = null;
		this.historySent.clear();
		this.pendingNews = [];
		this.schedules.clear();
	}

	private async boot(scenario: Record<string, unknown>, seed: number): Promise<void> {
		// Retain a clean copy of the scenario + seed so the factored evolver
		// (C2a) can project per-cluster sub-Worlds from the same source. World
		// construction may mutate its input, so clone before it runs.
		this.bootScenario = JSON.parse(JSON.stringify(scenario));
		this.bootSeed = seed;
		this.clusterEvolver = null;

		// Player-side custom metrics/correlations live across resets of the
		// SAME scenario. If this boot is for a different scenario, drop them.
		const scenarioKey = String((scenario as { key?: string; name?: string }).key
			?? (scenario as { name?: string }).name ?? '');
		if (this.playerScenarioKey !== null && this.playerScenarioKey !== scenarioKey) {
			this.playerCustomMetrics = [];
			this.playerCustomCorrelations = [];
			this.playerMetricSpecs.clear();
			this.playerCorrelationSpecs.clear();
		}
		this.playerScenarioKey = scenarioKey;

		// Always start from a clean slate, even when this is a `reset` after
		// a previous run. Drain the active loop first so its last newDay()
		// can finish on the *outgoing* world before we destroy it; otherwise
		// destroy() races with a still-running newDay.
		await this.drainCurrentLoop();
		this.teardown();

		if (!this.gpuInitialized) {
			this.gpuInitialized = true;
			this.gpu = await GpuContext.create();
			if (this.gpu) {
				this.shedKernel = new ShedAmountKernel(this.gpu);
				this.seekKernel = new SeekModKernel(this.gpu);
				this.applyShedKernel = new ApplyShedKernel(this.gpu);
				this.gpuPopState = new GpuPopState(this.gpu);
			} else {
				// Without WebGPU, the support class still exists as CPU-side
				// staging; its buffer fields stay null and the kernels are
				// never invoked.
				this.gpuPopState = new GpuPopState(null);
			}
			// Load the WASM SubSyndrome registry. We attempt this regardless
			// of WebGPU availability because the registry is its own win on
			// CPU paths too. If the fetch fails (jsdom test env, broken
			// build), fall back to the JS registry.
			try {
				this.subsynWasm = await getSubsynRegistry();
			} catch (err) {
				console.warn('[workerSim] WASM SubSyndromeRegistry load failed; using JS fallback', err);
				this.subsynWasm = null;
			}
		}

		this.system = new System(null);
		this.system.rand.seed(seed);
		// Worker-side renderIfNeeded: time-throttled yield. Returns `void`
		// most of the time so per-pop callers (Population.updateTransmission
		// / updatePopulations / updatePopulationsHistory) skip the await
		// entirely. Returns a Promise (causing a real macrotask yield) when
		// enough time has elapsed since the last yield — so pause messages
		// from the main thread land within `YIELD_INTERVAL_MS`, preserving
		// control responsiveness on slow days. The worker has no UI of its
		// own; this yield exists purely to let queued messages drain.
		const YIELD_INTERVAL_MS = 16;
		let lastWorkerYield = performance.now();
		(this.system as unknown as { renderIfNeeded: () => Promise<void> | void }).renderIfNeeded = () => {
			const now = performance.now();
			if (now - lastWorkerYield <= YIELD_INTERVAL_MS) return;
			lastWorkerYield = now;
			return new Promise<void>(r => setTimeout(r, 0));
		};

		this.world = new World(this.system as never, scenario);
		(this.system as unknown as { world: World }).world = this.world;
		const w = this.world as unknown as {
			shedAmountKernel: ShedAmountKernel | null;
			seekModKernel: SeekModKernel | null;
			applyShedKernel: ApplyShedKernel | null;
			gpuPopState: GpuPopState | null;
		};
		w.gpuPopState = this.gpuPopState;
		w.shedAmountKernel = this.useGpu ? this.shedKernel : null;
		w.seekModKernel = this.useGpu ? this.seekKernel : null;
		w.applyShedKernel = this.useGpu ? this.applyShedKernel : null;

		// Hand the WASM SubSyndrome registry to the new World after resetting
		// it — the WASM module is a process-wide singleton so prior state
		// from previous worlds would otherwise leak in.
		if (this.subsynWasm !== null) {
			this.subsynWasm.reset();
			(this.world as unknown as { subsynWasm: SubsynRegistryWasm }).subsynWasm = this.subsynWasm;
		}

		// Hand player-side custom metrics & correlations into the new World
		// so its replay step (World.start → replayCustomMetricsAndCorrelations)
		// can rebind them. We pass the *previous* CustomMetric instances so
		// their expression_data survives intact.
		const wPrev = this.world as unknown as {
			custom_metrics_prev?: unknown[];
			custom_traits_prev?: unknown[];
		};
		if (this.playerCustomMetrics.length > 0) {
			wPrev.custom_metrics_prev = this.playerCustomMetrics.slice();
		}
		if (this.playerCustomCorrelations.length > 0) {
			wPrev.custom_traits_prev = this.playerCustomCorrelations.slice();
		}

		// teardown() bumped runGen and cleared the per-run state; no need
		// to repeat that here.
		await this.world.start();

		// After start, re-snapshot the player cache from the live world so the
		// canonical references are the freshly-bound objects (CustomMetric.world
		// now points to this world, expression rebound).
		const wPost = this.world as unknown as {
			custom_metrics: CustomMetric[];
			custom_traits: Array<{ kind: 'correlation'; key: string; data: Record<string, unknown> }>;
		};
		this.playerCustomMetrics = wPost.custom_metrics.slice();
		this.playerCustomCorrelations = wPost.custom_traits.slice();

		// Reset the C2-final promotion gate for the new world.
		this.clusterPromoted = false;
		this.clusterPromotionDecided = false;
		this.clusterWarmupCount = 0;
		this.clusterWarmupMaxResidual = 0;

		// Phase C0+: if clustering is enabled, run the static detector + shadow
		// verifier (diagnostics) and build the factored evolver at day 0 so the
		// promotion gate can compare it against the joint from the first step.
		if (this.clustering) {
			this.computeAndPostClusters();
			await this.buildClusterEvolver();
		} else {
			this.clusterReport = null;
		}
	}

	/** Run the static cluster detector and emit a `clusterReport`. Safe to call
	 * only when a world exists. Diagnostics-only (Phase C0). */
	computeAndPostClusters(): ClusterReport | null {
		if (!this.world) return null;
		try {
			// C1: build the runtime partition (clusters over base traits) and run
			// the shadow verifier against the current world state. Pure analysis.
			const partition = buildPartition(this.world as never);
			this.clusterPartition = partition;
			const report = partition.report;
			this.clusterReport = report;
			this.resetClusterMonitor();

			const v = verifyFactorization(this.world as never, partition);
			console.log(formatClusterReport(report));
			this.emitClusterReport(v);
			return report;
		} catch (err) {
			console.warn('[clustering] detector failed', err);
			this.clusterReport = null;
			this.clusterPartition = null;
			return null;
		}
	}

	/**
	 * Build the factored per-cluster evolver (C2a) from the boot scenario and
	 * current partition. Returns null when clustering isn't active, no partition
	 * exists, or the partition has exit coupling (death) — the latter needs the
	 * C2b decrement glue before the evolver is faithful. The joint engine stays
	 * authoritative; this is a verified shadow / substitute-in-waiting.
	 */
	async buildClusterEvolver(): Promise<FactoredEvolver | null> {
		if (!this.clustering || !this.clusterPartition || !this.bootScenario || !this.world) return null;
		// Routes (cross-site sheds + migration) are not yet modeled by the
		// factored evolver's per-cluster sub-Worlds. Refuse and keep the
		// joint engine authoritative — the safe fallback the C-series
		// already defines. Lift when route flows get projection glue.
		if ((this.world as unknown as { routes?: unknown[] }).routes?.length) {
			console.log('[clustering] scenario has routes — factored evolver disabled (joint engine stays authoritative)');
			return null;
		}
		// Build from the ACTIVE partition for the current resource values (split
		// where a resource-gated coupling is off), not the conservative structural
		// one — so the evolver starts in the cheapest valid state. The day loop
		// re-partitions from here as couplings toggle (C3).
		const active = buildPartition(this.world as never, { resourceValues: this.currentResourceValues(), band: this.clusterGateBand });
		const ev = await FactoredEvolver.build(this.bootScenario, active, this.bootSeed);
		this.clusterEvolver = ev;
		console.log(`[clustering] factored evolver built: ${ev.clusterIds.length} cluster sub-Worlds` +
			(ev.hasExitCoupling ? ' (with full-strip removal glue)' : ''));
		return ev;
	}

	/** Current resource values seen by the factored sim (the evolver's reconciled
	 * shared stockpiles, falling back to the joint world's). */
	private currentResourceValues(): Record<string, number> {
		const rv: Record<string, number> = {};
		const stocks = (this.world as unknown as { all_stockpiles?: { resource: { key: string }; value: number }[] }).all_stockpiles ?? [];
		for (const sp of stocks) rv[sp.resource.key] = sp.value;
		if (this.clusterEvolver) for (const [k, v] of this.clusterEvolver.resourceValues()) rv[k] = v;
		return rv;
	}

	/** C3: reconcile the evolver's sub-World partition to the ACTIVE-edge partition
	 * for the current resource values. Cheap when no resource-gated couplings exist
	 * (nothing can toggle) or when the partition is unchanged (no rebuilds). */
	private async repartitionEvolver(): Promise<void> {
		const ev = this.clusterEvolver;
		if (!ev || !this.world) return;
		if (!this.clusterReport || this.clusterReport.gateEdges.length === 0) return;
		const active = buildPartition(this.world as never, { resourceValues: this.currentResourceValues(), band: this.clusterGateBand });
		await ev.repartition(active.clusters.map(c => [...c.traitKeys]), this.clusterSplitEps);
	}

	private resetClusterMonitor(): void {
		this.clusterMonitor = { daysChecked: 0, lastResidual: 0, maxResidualSeen: 0, maxResidualDay: -1, breaches: 0, inBreach: false };
	}

	/** Post a clusterReport carrying the current static report + the given
	 * verification. Requires `this.clusterReport` to be set. */
	private emitClusterReport(v: FactorVerification): void {
		const report = this.clusterReport;
		if (!report) return;
		const livingN = v.sites.reduce((n, s) => n + s.livingN, 0);
		const absorbedN = v.sites.reduce((n, s) => n + s.absorbedN, 0);
		console.log(`[clustering] verify: residual=${v.maxResidual.toExponential(2)} ` +
			`jointPops=${v.jointPopsTotal} factoredStates=${v.factoredStatesTotal} ` +
			`costRatio=${v.costRatio.toFixed(3)} (living=${livingN.toFixed(0)} absorbed=${absorbedN.toFixed(0)})`);
		this.post({
			type: 'clusterReport',
			report: {
				clusters: report.clusters,
				membership: report.membership,
				terminal: report.terminal,
				exitTraits: report.exitTraits,
				gateEdges: report.gateEdges,
				traitCount: report.traitCount,
				verification: {
					maxResidual: v.maxResidual,
					jointPops: v.jointPopsTotal,
					factoredStates: v.factoredStatesTotal,
					costRatio: v.costRatio,
					livingN, absorbedN,
				},
			},
		});
	}

	/**
	 * Advance the simulation one day. Single chokepoint for `step` and `run`.
	 * - Promoted (C2-final): run ONLY the factored evolver and reconstruct the
	 *   joint world's living populations + resources from its marginals so the
	 *   existing snapshot path keeps working. The joint dynamics never run — that
	 *   is the cost saving.
	 * - Otherwise: run the joint engine; if clustering is on, also step the
	 *   evolver as a shadow and feed the promotion gate, then run the monitor.
	 */
	private async advanceDay(): Promise<void> {
		if (this.clusterPromoted && this.clusterEvolver) {
			await this.repartitionEvolver();   // merge/split as gated couplings toggle (C3)
			await this.clusterEvolver.step();
			this.syncJointFromEvolver();
			return;
		}
		await this.requireWorld().newDay();
		if (this.clustering && this.clusterEvolver && !this.clusterPromotionDecided) {
			await this.repartitionEvolver();
			await this.clusterEvolver.step();
			this.clusterWarmupGate();
		}
		this.afterDay();
	}

	/** Promotion gate: accumulate the evolver-vs-joint residual over the warmup
	 * window, then promote (evolver-only) or fall back (drop evolver). */
	private clusterWarmupGate(): void {
		if (!this.clusterEvolver || !this.world) return;
		// Partition-INDEPENDENT check (the evolver may re-partition during warmup):
		// does its reconstruction reproduce the joint's living populations? This
		// captures both marginal tracking and correlation — if the evolver wrongly
		// kept a correlated pair split, its product reconstruction mismatches.
		const sites = (this.world as unknown as { sites: { pops: { pop: number; syndrome: { trait_keys: string[] } }[] }[] }).sites;
		const residual = this.clusterEvolver.reconstructionResidual(sites);
		this.clusterWarmupMaxResidual = Math.max(this.clusterWarmupMaxResidual, residual);
		if (++this.clusterWarmupCount < this.clusterWarmupDays) return;

		this.clusterPromotionDecided = true;
		if (this.clusterWarmupMaxResidual < this.clusterResidualThreshold) {
			this.clusterPromoted = true;
			console.log(`[clustering] evolver PROMOTED after ${this.clusterWarmupCount}d warmup ` +
				`(max residual ${this.clusterWarmupMaxResidual.toExponential(2)}) — joint engine frozen.`);
		} else {
			console.log(`[clustering] evolver NOT promoted (max residual ` +
				`${this.clusterWarmupMaxResidual.toExponential(2)} ≥ ${this.clusterResidualThreshold}) — staying on joint.`);
			this.clusterEvolver.destroy();
			this.clusterEvolver = null;
		}
	}

	/** Reconstruct the joint world's LIVING population counts + resource values
	 * from the evolver's marginals so `snapshot()` reflects the factored run.
	 * (Absorbed/dead per-syndrome breakdown is not yet factored-tracked; living
	 * quantities and resources are authoritative.) */
	private syncJointFromEvolver(): void {
		const ev = this.clusterEvolver;
		if (!ev || !this.world) return;
		const w = this.world as unknown as {
			age: number;
			sites: { pops: { pop: number; syndrome: { trait_keys: string[] } }[] }[];
			all_stockpiles: { resource: { key: string }; value: number; setValue(v: number): void }[];
		};
		for (const site of w.sites) {
			for (const p of site.pops) p.pop = ev.syndromeCount(p.syndrome.trait_keys);
		}
		const rv = ev.resourceValues();
		for (const sp of w.all_stockpiles) {
			const v = rv.get(sp.resource.key);
			if (v !== undefined && sp.value !== v) sp.setValue(v);
		}
		w.age++;
	}

	/**
	 * Factorization monitor — runs after each simulated day while clustering is
	 * active. Re-verifies that the live joint still factors along the partition
	 * built at boot. The partition is NOT rebuilt mid-scenario (clustering is a
	 * boot/test toggle, not a runtime switch); this only watches. On a rising
	 * residual breach it emits a fresh clusterReport so the alarm surfaces.
	 */
	private afterDay(): void {
		if (!this.clustering || !this.clusterPartition || !this.world) return;
		const interval = Math.max(1, this.clusterMonitorInterval | 0);
		const day = (this.world as unknown as { age: number }).age;
		if (day % interval !== 0) return;

		let v: FactorVerification;
		try { v = verifyFactorization(this.world as never, this.clusterPartition); }
		catch (err) { console.warn('[clustering] monitor verify failed', err); return; }

		const m = this.clusterMonitor;
		m.daysChecked++;
		m.lastResidual = v.maxResidual;
		if (v.maxResidual > m.maxResidualSeen) { m.maxResidualSeen = v.maxResidual; m.maxResidualDay = day; }

		const over = v.maxResidual > this.clusterMonitorThreshold;
		if (over && !m.inBreach) {
			// rising edge: raise the alarm once, emit a fresh report
			m.breaches++;
			m.inBreach = true;
			console.warn(`[clustering] FACTORIZATION BREACH day ${day}: residual=` +
				`${v.maxResidual.toExponential(2)} > ${this.clusterMonitorThreshold} — a coupling the ` +
				`static detector missed has correlated otherwise-independent clusters.`);
			this.emitClusterReport(v);
		} else if (!over && m.inBreach) {
			m.inBreach = false; // recovered; arm the alarm again
		}
	}

	private requireWorld(): World {
		if (!this.world) throw new Error('Worker received command before start');
		return this.world;
	}

	/* ------------------------- Snapshot building ------------------------- */

	private snapshot(): Snapshot {
		if (!this.world) {
			return {
				age: 0, sites: [], historyDelta: [], news: [], actions: [],
				stockpiles: [], hiddenTrackerIds: [], grayedOutTrackerIds: [], pauseRequested: false,
			};
		}
		const w = this.world as unknown as {
			age: number;
			sites: SiteRuntime[];
			actions: ActionRuntime[];
			global_actions: ActionRuntime[];
			local_actions: ActionRuntime[];
			global_stockpiles: StockpileRuntime[];
			all_stockpiles: StockpileRuntime[];
			trackers: TrackerRuntime[];
			news_pending: NewsItemRuntime[];
			trait_hist: HistoryRuntime[];
			resource_hist: HistoryRuntime[];
			metric_hist: HistoryRuntime[];
		};

		// Drain news from the world into our outbound queue, then *clear*
		// the world's queue so the same items don't get shipped twice.
		// (World.addNewsItems used to clear here for the legacy GUI; we took
		// ownership when we moved the GUI off the world's thread.)
		const worldNews = w.news_pending || [];
		if (worldNews.length > 0) {
			this.drainNews(worldNews);
			worldNews.length = 0;
		}
		const news = this.pendingNews;
		this.pendingNews = [];

		// Pause requested when any new item has body text and is auto.
		const pauseRequested = news.some(n => n.auto && n.body !== '');

		const stockpiles: StockpileValueSnapshot[] = [];
		for (const sp of w.all_stockpiles || []) {
			stockpiles.push({
				id: this.stockpileId(sp),
				siteKey: sp.site ? (sp.site.key ?? null) : null,
				value: typeof sp.value === 'number' ? sp.value : 0,
			});
		}

		const actions: ActionSnapshot[] = this.collectActionSnapshots(w);

		// Live `hidden` state — scenario-declared `hidden: true` plus any
		// `resource_vis` events that fired since start. Tracker.hidden is
		// the runtime field; `tracker.graph_hidden` (for the legacy "show
		// in panel but not graph" mode) maps onto our `hiddenSeries` UI
		// state instead, since the player can also toggle that themselves.
		const hiddenTrackerIds: string[] = [];
		const grayedOutTrackerIds: string[] = [];
		for (const t of w.trackers || []) {
			if (t.hidden) hiddenTrackerIds.push(this.trackerIdFor(t));
			// Metrics carry their own grayed_out; correlation-traits carry it
			// too (set when the trait's referenced traits become hidden).
			const grayed = t.metric?.grayed_out || t.trait?.grayed_out;
			if (grayed) grayedOutTrackerIds.push(this.trackerIdFor(t));
		}

		const trackerPatch = this.pendingTrackerPatch;
		this.pendingTrackerPatch = null;

		return {
			age: w.age,
			sites: w.sites.map(site => ({
				key: site.key,
				pop: site.pop,
				pops: site.pops
					.filter(p => p.pop > 0)
					.map(p => ({ syndromeKey: p.syndrome.key, pop: p.pop })),
			})),
			historyDelta: this.collectHistoryDeltas(w),
			news,
			actions,
			stockpiles,
			hiddenTrackerIds,
			grayedOutTrackerIds,
			pauseRequested,
			...(trackerPatch ? { trackerPatch } : {}),
		};
	}

	/** Same composition as `trackerMeta` so snapshot-side hidden IDs match
	 * bootstrap-side tracker IDs. */
	private trackerIdFor(t: TrackerRuntime): string {
		const type: 'trait' | 'resource' | 'metric' =
			t.type === 2 || t.resource ? 'resource' :
				t.type === 3 || t.metric ? 'metric' : 'trait';
		return `${type}:${t.key}`;
	}

	private collectHistoryDeltas(w: {
		trait_hist: HistoryRuntime[];
		resource_hist: HistoryRuntime[];
		metric_hist: HistoryRuntime[];
		sites: SiteRuntime[];
	}): HistoryDeltaSnapshot[] {
		const out: HistoryDeltaSnapshot[] = [];
		// World-level histories. For non-global trackers (traits, per-site
		// resources, per-site metrics) these are *combined* sums across all
		// sites computed via History.is_combined_hist — exactly what the
		// world view needs.
		const tag = (
			list: HistoryRuntime[] | undefined,
			type: 'trait' | 'resource' | 'metric',
			siteKey?: string,
		) => {
			for (const hist of list || []) {
				if (!hist || !hist.tracker) continue;
				this.appendDelta(out, `${type}:${hist.tracker.key}`, siteKey, hist);
			}
		};
		tag(w.trait_hist, 'trait');
		tag(w.resource_hist, 'resource');
		tag(w.metric_hist, 'metric');
		// Per-site histories. Sites populate trait_hist for every trait
		// tracker, plus resource_hist for non-global resources, plus
		// metric_hist for any metric whose tracker is non-global. Iterate
		// the *_kv maps so we hit every per-site history even if the array
		// happens to be empty.
		for (const site of w.sites || []) {
			tag(site.trait_hist, 'trait', site.key);
			const resMap = site.resource_hist_kv || {};
			for (const k of Object.keys(resMap)) {
				const hist = resMap[k];
				if (!hist || !hist.tracker) continue;
				this.appendDelta(out, `resource:${hist.tracker.key}`, site.key, hist);
			}
			tag(site.metric_hist, 'metric', site.key);
		}
		return out;
	}

	private appendDelta(
		out: HistoryDeltaSnapshot[],
		trackerId: string,
		siteKey: string | undefined,
		hist: HistoryRuntime,
	): void {
		const start = typeof hist.start === 'number' ? hist.start : 0;
		const arr = hist.val || [];
		const totalLen = arr.length;
		const lastEnd = start + totalLen; // exclusive
		const k = `${trackerId}|${siteKey ?? ''}`;
		const sentEnd = this.historySent.get(k) ?? start; // inclusive of last-sent
		if (lastEnd <= sentEnd) return;
		const sliceStartDay = Math.max(start, sentEnd);
		const sliceStartIdx = sliceStartDay - start;
		const values = arr.slice(sliceStartIdx);
		if (values.length === 0) return;
		const item: HistoryDeltaSnapshot = { trackerId, startDay: sliceStartDay, values };
		if (siteKey !== undefined) item.siteKey = siteKey;
		out.push(item);
		this.historySent.set(k, lastEnd);
	}

	private drainNews(pending: NewsItemRuntime[]): void {
		for (const n of pending) {
			const id = `n${++this.newsCounter}`;
			this.pendingNews.push({
				id,
				day: typeof n.day === 'number' ? n.day : (this.world?.age ?? 0),
				title: n.title ?? '',
				body: n.text ?? '',
				siteKey: n.siteKey ?? null,
				auto: !!n.auto,
			});
		}
	}

	private collectActionSnapshots(w: {
		global_actions: ActionRuntime[];
		local_actions: ActionRuntime[];
		sites: SiteRuntime[];
	}): ActionSnapshot[] {
		const out: ActionSnapshot[] = [];
		// Legacy semantic: `enabled` is the live visibility flag — when false,
		// the action is hidden from the UI. `hidden` in the JSON is just an
		// init shortcut (PlayerAction.init sets `enabled = !hidden`). The
		// `action_vis` event toggles `enabled`, so we *must* read `enabled`
		// rather than `hidden` to reflect runtime changes (e.g. an action
		// revealed partway through a scenario).
		for (const a of w.global_actions || []) {
			out.push({
				id: a.key,
				siteKey: null,
				desiredValue: a.desired_value ?? 0,
				currentValue: a.current_value ?? 0,
				costCappedValue: a.cost_capped_value ?? null,
				hidden: a.enabled === false,
				disabled: false,
				disabledReason: a.disabled_reason ?? null,
				schedule: this.schedules.get(`${a.key}|`) ?? [],
			});
		}
		for (const a of w.local_actions || []) {
			for (const s of w.sites || []) {
				const inst = s.actions_kv?.[a.key];
				const enabled = inst?.enabled ?? a.enabled;
				out.push({
					id: a.key,
					siteKey: s.key,
					desiredValue: inst?.desired_value ?? a.desired_value ?? 0,
					currentValue: inst?.current_value ?? a.current_value ?? 0,
					costCappedValue: a.cost_capped_value ?? null,
					hidden: enabled === false,
					disabled: false,
					disabledReason: inst?.disabled_reason ?? null,
					schedule: this.schedules.get(`${a.key}|${s.key}`) ?? [],
				});
			}
		}
		return out;
	}

	/* ----------------------------- Bootstrap ----------------------------- */

	private bootstrap(): Bootstrap {
		const w = this.world as unknown as {
			data?: { name?: string; key?: string };
			name?: string;
			use_date?: boolean | number;
			start_date?: string;
			day_string?: string;
			sites: SiteRuntime[];
			guigroups: GUIGroupRuntime[];
			trackers: TrackerRuntime[];
			global_actions: ActionRuntime[];
			local_actions: ActionRuntime[];
			all_stockpiles: StockpileRuntime[];
			all_phases: IndexedPhaseRuntime[];
		};
		const scenarioKey = (w.data && (w.data.key || w.data.name)) || w.name || 'scenario';
		const scenarioName = w.name || (w.data?.name ?? scenarioKey);

		return {
			scenarioKey: String(scenarioKey),
			scenarioName: String(scenarioName),
			sites: (w.sites || []).map(s => ({ key: s.key, name: s.name ?? s.key, totalPop: s.pop })),
			// Skip the default zero-key GUIGroup. The world auto-instantiates one
			// under the empty key as a fallback for trackers/actions that didn't
			// pick a group; it is not a player-visible category. The GUI surfaces
			// those entries via its own ungrouped-section logic instead.
			guiGroups: (w.guigroups || [])
				.filter(g => g.key !== '')
				.map((g, i) => ({
					key: g.key,
					name: g.name ?? g.key,
					parentKey: typeof g.parent === 'string' ? g.parent : (g.parent?.key ?? null),
					order: g.index ?? i,
				})),
			trackers: (w.trackers || []).map(t => this.trackerMeta(t)),
			// Local actions: iterate the per-site INSTANCES rather than the
			// world-level templates. PlayerAction.init runs once per site
			// instance and resolves each cost/produce's `.stockpile` and
			// `.phase_index`; the un-init'd template would emit blank
			// stockpileIds and clobber the client's affordability math.
			actions: [
				...(w.global_actions || []).map(a => this.actionMeta(a, null)),
				...(w.sites || []).flatMap(s => (s.actions || []).map(a => this.actionMeta(a, s.key))),
			],
			stockpiles: (w.all_stockpiles || []).map(sp => ({
				id: this.stockpileId(sp),
				name: sp.resource.getName?.() ?? sp.resource.key,
				color: '#cccccc',
				global: !!sp.resource.global,
				signed: !!sp.resource.signed,
			})),
			phases: (w.all_phases || []).map(p => p.key),
			useDate: !!w.use_date,
			startDate: w.start_date ?? '',
			dayString: w.day_string && w.day_string !== '' ? w.day_string : 'Day',
		};
	}

	private trackerMeta(t: TrackerRuntime): TrackerMeta {
		// Normalize the world's "no group selected" sentinel ('' string OR a
		// runtime GUIGroup with key '') to null, so the UI's ungrouped path
		// is the single source of truth for un-categorized rows.
		const rawGroupKey = typeof t.guigroup === 'string' ? t.guigroup : (t.guigroup?.key ?? null);
		const groupKey = rawGroupKey === '' ? null : rawGroupKey;
		// HIST_TYPE: 1=TRAIT, 2=RESOURCE, 3=METRIC. Fall back to the runtime
		// shape (.resource / .metric set) if `type` is missing on the tracker.
		const type: 'trait' | 'resource' | 'metric' =
			t.type === 2 || t.resource ? 'resource' :
				t.type === 3 || t.metric ? 'metric' : 'trait';
		const playerCreated = !!t.metric || !!t.trait?.is_correlation;
		// For player-created entries, ship an empty name when the player left
		// the field blank — the client renders the formula or definition in
		// place. Built-in trackers still fall back to t.key for safety.
		const rawName = t.obj?.name ?? '';
		const name = rawName !== '' ? rawName : (playerCreated ? '' : t.key);
		const metricSpec = playerCreated && type === 'metric'
			? this.playerMetricSpecs.get(t.key) : undefined;
		const correlationSpec = playerCreated && type === 'trait'
			? this.playerCorrelationSpecs.get(t.key) : undefined;
		// `global` follows the runtime semantics: true = the tracker has only
		// a world-level history (e.g. global resources, metrics). false = the
		// tracker has per-site histories AND a world-level *combined* sum
		// computed across them. Traits are always per-site (`global: false`)
		// so the world graph aggregates them and site graphs read each site
		// directly.
		return {
			// Namespace by type so a trait and a resource sharing a base_key
			// (e.g. both "dead") don't collide in the legend, status panel,
			// or the client-side history map.
			id: `${type}:${t.key}`,
			name,
			color: t.color,
			groupKey,
			type,
			global: !!t.global,
			hiddenDefault: !!t.hidden,
			displayMode: (t.resource?.graph_display as 'absolute' | 'perc' | 'none' | undefined)
				|| (t.metric?.perc ? 'perc' as const : 'absolute' as const),
			playerCreated,
			precision: t.metric?.precision,
			metricSpec,
			correlationSpec,
		};
	}

	private actionMeta(a: ActionRuntime, siteKey: string | null) {
		const rawGroupKey = typeof a.guigroup === 'string' ? a.guigroup : (a.guigroup?.key ?? null);
		const groupKey = rawGroupKey === '' ? null : rawGroupKey;
		const type: 'toggle' | 'slider' | 'number' =
			a.type === 'toggle' || a.type === 'slider' || a.type === 'number'
				? a.type : (a.max != null && a.min != null && a.max - a.min === 1 ? 'toggle' : 'slider');
		// PlayerAction stores its cost children under `cost` (singular).
		// Cost values are always positive (consumption); the GUI displays
		// them with a leading '-' so the sign matches the player's mental
		// model ("you lose 5 of X"). Produces are signed: positive produces,
		// negative drains.
		const resourceName = (r: { resource_obj?: { key?: string; name?: string; getName?: () => string }; resource: string }) =>
			r.resource_obj?.getName?.()
			|| r.resource_obj?.name
			|| r.resource_obj?.key
			|| r.resource;
		const cost = (a.cost ?? []).map(c => `-${c.value} ${resourceName(c)}`).join(', ');
		const produce = (a.produce ?? []).map(p => {
			const sign = p.value >= 0 ? '+' : '';
			const sd = p.sd && p.sd > 0 ? ` (±${p.sd})` : '';
			return `${sign}${p.value}${sd} ${resourceName(p)}`;
		}).join(', ');
		const costs = (a.cost ?? []).map(c => ({
			resource: c.resource,
			value: c.value,
			phaseIndex: c.phase_index ?? 0,
			stockpileId: c.stockpile ? this.stockpileId(c.stockpile) : '',
		}));
		const produces = (a.produce ?? []).map(p => ({
			resource: p.resource,
			value: p.value,
			sd: p.sd,
			phaseIndex: p.phase_index ?? 0,
			stockpileId: p.stockpile ? this.stockpileId(p.stockpile) : '',
		}));
		return {
			id: a.key,
			name: a.name ?? a.key,
			groupKey,
			siteKey,
			type,
			min: typeof a.min === 'number' ? a.min : 0,
			max: typeof a.max === 'number' ? a.max : 1,
			step: typeof a.step === 'number' ? a.step : 1,
			costSummary: cost,
			produceSummary: produce,
			costs,
			produces,
		};
	}

	private stockpileId(sp: StockpileRuntime): string {
		const siteKey = sp.site?.key ?? '';
		return `${sp.resource.key}|${siteKey}`;
	}

	/* ---------------------------- Action input --------------------------- */

	private setActionDesired(actionId: string, siteKey: string | null, value: number): void {
		if (!this.world) return;
		const w = this.world as unknown as {
			actions_kv: Record<string, ActionRuntime>;
			sites: SiteRuntime[];
		};
		const a = w.actions_kv[actionId];
		if (!a) return;
		if (siteKey === null || a.global) {
			a.desired_value = value;
		} else {
			const site = (w.sites || []).find(s => s.key === siteKey);
			const inst = site?.actions_kv?.[actionId];
			if (inst) inst.desired_value = value;
			else a.desired_value = value;
		}
	}

	private scheduleAction(actionId: string, siteKey: string | null, day: number, value: number): void {
		const k = `${actionId}|${siteKey ?? ''}`;
		const arr = this.schedules.get(k) ?? [];
		// Replace any existing entry for the same day, then sort.
		const filtered = arr.filter(c => c.day !== day);
		filtered.push({ day, value });
		filtered.sort((a, b) => a.day - b.day);
		this.schedules.set(k, filtered);
	}

	private cancelScheduled(actionId: string, siteKey: string | null, day: number): void {
		const k = `${actionId}|${siteKey ?? ''}`;
		const arr = this.schedules.get(k);
		if (!arr) return;
		this.schedules.set(k, arr.filter(c => c.day !== day));
	}

	/** Apply any scheduled changes whose day is "today" — i.e. the day we're
	 * about to step into. Called at the top of step / run iteration, before
	 * `world.newDay`, so the change participates in the day's lock-in. */
	private applyScheduledChanges(): void {
		if (!this.world) return;
		const today = this.world.age;
		for (const [k, arr] of this.schedules) {
			const remaining: ScheduledChange[] = [];
			for (const c of arr) {
				if (c.day <= today) {
					const [actionId, siteKey] = k.split('|');
					this.setActionDesired(actionId, siteKey || null, c.value);
				} else {
					remaining.push(c);
				}
			}
			if (remaining.length === 0) this.schedules.delete(k);
			else this.schedules.set(k, remaining);
		}
	}
}

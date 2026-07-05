/**
 * SimClient — main-thread proxy for the simulation worker.
 *
 * Owns the Worker, sends ClientMsg, dispatches WorkerMsg to subscribers
 * and to in-flight Promise resolvers. Callers see a Promise-based API
 * where `await client.step(10)` returns the snapshot at day N+10.
 *
 * The worker is constructed lazily on first method call (or eagerly via
 * `prewarm()`). One SimClient owns one Worker for its lifetime; call
 * `dispose()` to terminate.
 */

import type { ClientMsg, WorkerMsg, Snapshot, Bootstrap, CustomMetricSpec, CustomCorrelationSpec, ClusterReportMsg } from './protocol';

type SnapshotListener = (snapshot: Snapshot) => void;
type BootstrapListener = (bootstrap: Bootstrap) => void;
type ErrorListener = (err: Error) => void;

interface PendingResolver {
	type: WorkerMsg['type'];
	/** Most pending requests resolve to a Snapshot; `shutdown_done` doesn't
	 * carry one, so we accept either shape. */
	resolve: (snapshot?: Snapshot) => void;
	reject: (err: Error) => void;
}

export class SimClient {
	private worker: Worker | null = null;
	/**
	 * FIFO queue of in-flight requests waiting for their response. Each
	 * request that expects a single response (start, step, reset, pause)
	 * pushes here; the next matching incoming WorkerMsg pops the head.
	 * 'run' messages don't push (they have no single response).
	 */
	private pending: PendingResolver[] = [];
	private snapshotListeners = new Set<SnapshotListener>();
	private bootstrapListeners = new Set<BootstrapListener>();
	private errorListeners = new Set<ErrorListener>();
	private latest: Snapshot | null = null;
	private bootstrap: Bootstrap | null = null;
	private disposed: boolean = false;
	/** Last-known GPU state. Populated by every `started` message. */
	private _gpuAvailable: boolean = false;
	private _gpuActive: boolean = false;
	/** Last cluster report (Phase C0 diagnostics) + its listeners. */
	private _clusterReport: ClusterReportMsg | null = null;
	private clusterListeners = new Set<(r: ClusterReportMsg) => void>();

	/** Returns the most recent snapshot, or null before any started/snapshot. */
	getLatest(): Snapshot | null {
		return this.latest;
	}

	gpuAvailable(): boolean { return this._gpuAvailable; }
	gpuActive(): boolean { return this._gpuActive; }

	/**
	 * Force the worker onto the CPU path (or restore the GPU path). Takes
	 * effect on the next `start`/`reset` because that's when the World is
	 * (re)constructed and the kernel reference is wired in.
	 */
	setUseGpu(enabled: boolean): void {
		this.send({ type: 'setUseGpu', enabled });
	}

	/** Toggle the worker-side simulation profiler. When on, each `newDay`
	 * prints a per-phase / per-batch timing breakdown via console.table. */
	setProfiler(enabled: boolean): void {
		this.send({ type: 'setProfiler', enabled });
	}

	/** Toggle the experimental trait-clustering system (Phase C0: diagnostics
	 * only). When enabled the worker runs the static cluster detector on the
	 * current/next world and emits a `clusterReport`; subscribe via
	 * `onClusterReport`. No simulation behavior changes yet. */
	setClustering(enabled: boolean): void {
		this.send({ type: 'setClustering', enabled });
	}

	/** Most recent cluster report from the worker, or null. */
	getClusterReport(): ClusterReportMsg | null { return this._clusterReport; }

	/** Subscribe to cluster reports. Returns an unsubscribe fn. Replays the
	 * last report immediately if one exists. */
	onClusterReport(cb: (r: ClusterReportMsg) => void): () => void {
		this.clusterListeners.add(cb);
		if (this._clusterReport) cb(this._clusterReport);
		return () => { this.clusterListeners.delete(cb); };
	}

	subscribe(cb: SnapshotListener): () => void {
		this.snapshotListeners.add(cb);
		// Replay the latest snapshot so a late-mounting subscriber still
		// applies day-0 history deltas. Without this, if `started` lands on
		// the main thread before the App's useEffect runs (typical for fast
		// scenarios), the initial snapshot is dropped and the trait/resource
		// series remain empty until a future step. Bootstrap is replayed by
		// `onBootstrap` for the same reason.
		if (this.latest) cb(this.latest);
		return () => this.snapshotListeners.delete(cb);
	}

	onBootstrap(cb: BootstrapListener): () => void {
		this.bootstrapListeners.add(cb);
		if (this.bootstrap) cb(this.bootstrap);
		return () => this.bootstrapListeners.delete(cb);
	}

	onError(cb: ErrorListener): () => void {
		this.errorListeners.add(cb);
		return () => this.errorListeners.delete(cb);
	}

	getBootstrap(): Bootstrap | null { return this.bootstrap; }

	setActionDesired(actionId: string, siteKey: string | null, value: number): void {
		this.send({ type: 'setActionDesired', actionId, siteKey, value });
	}

	scheduleAction(actionId: string, siteKey: string | null, day: number, value: number): void {
		this.send({ type: 'scheduleAction', actionId, siteKey, day, value });
	}

	cancelScheduled(actionId: string, siteKey: string | null, day: number): void {
		this.send({ type: 'cancelScheduled', actionId, siteKey, day });
	}

	addCustomMetric(spec: CustomMetricSpec): void {
		this.send({ type: 'addCustomMetric', spec });
	}

	removeCustomMetric(metricBaseKey: string): void {
		this.send({ type: 'removeCustomMetric', metricBaseKey });
	}

	addCorrelation(spec: CustomCorrelationSpec): void {
		this.send({ type: 'addCorrelation', spec });
	}

	removeCustomTrait(traitBaseKey: string): void {
		this.send({ type: 'removeCustomTrait', traitBaseKey });
	}

	editCustomMetric(metricBaseKey: string, spec: CustomMetricSpec): void {
		this.send({ type: 'editCustomMetric', metricBaseKey, spec });
	}

	editCorrelation(traitBaseKey: string, spec: CustomCorrelationSpec): void {
		this.send({ type: 'editCorrelation', traitBaseKey, spec });
	}

	start(scenario: Record<string, unknown>, seed: number): Promise<Snapshot> {
		return this.requestSnapshot(
			{ type: 'start', scenario, seed },
			'started',
		);
	}

	step(count: number = 1): Promise<Snapshot> {
		return this.requestSnapshot({ type: 'step', count }, 'snapshot');
	}

	/**
	 * Start the run loop. Returns immediately; observe progress via
	 * `subscribe(cb)`. Use `pause()` to stop.
	 *
	 * @param msPerDay  Wall-clock target for one simulation day. 0 = as
	 *                  fast as possible (still yields between days so
	 *                  pause messages land).
	 * @param snapshotEveryDays  How many simulated days between snapshots
	 *                           sent back to main. Stays at 1 for normal
	 *                           speeds; jump higher for max speed where
	 *                           rendering can't keep up with day rate.
	 */
	run(msPerDay: number = 0, snapshotEveryDays: number = 1): void {
		this.send({ type: 'run', msPerDay, snapshotEveryDays });
	}

	pause(): Promise<Snapshot> {
		return this.requestSnapshot({ type: 'pause' }, 'paused');
	}

	reset(scenario: Record<string, unknown>, seed: number): Promise<Snapshot> {
		return this.requestSnapshot(
			{ type: 'reset', scenario, seed },
			'started',
		);
	}

	/**
	 * Tear down the running world. After this resolves, no simulation is
	 * in flight — the worker holds no World/System reference. Calling
	 * step/run/pause until the next start/reset will fail on the worker.
	 * Used by the editor: while the user edits, no sim should be alive.
	 */
	shutdown(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const entry: PendingResolver = {
				type: 'shutdown_done',
				resolve: () => resolve(),
				reject,
			};
			this.pending.push(entry);
			try {
				this.send({ type: 'shutdown' });
			} catch (err) {
				const idx = this.pending.indexOf(entry);
				if (idx !== -1) this.pending.splice(idx, 1);
				reject(err as Error);
			}
		});
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.worker?.terminate();
		this.worker = null;
		// Reject any in-flight requests.
		const err = new Error('SimClient disposed');
		for (const p of this.pending) p.reject(err);
		this.pending = [];
	}

	// -----------------------------------------------------------------------

	private ensureWorker(): Worker {
		if (this.worker) return this.worker;
		if (this.disposed) throw new Error('SimClient disposed');
		this.worker = new Worker(
			new URL('./worker.ts', import.meta.url),
			{ type: 'module', name: 'sim-worker' },
		);
		this.worker.addEventListener('message', this.handleMessage);
		this.worker.addEventListener('error', this.handleWorkerError);
		return this.worker;
	}

	private send(msg: ClientMsg): void {
		this.ensureWorker().postMessage(msg);
	}

	private requestSnapshot(msg: ClientMsg, expect: WorkerMsg['type']): Promise<Snapshot> {
		return new Promise<Snapshot>((resolve, reject) => {
			// Snapshot resolvers always receive a Snapshot — but PendingResolver
			// types `resolve` as `(snap?: Snapshot)` to accommodate
			// `shutdown_done` (no payload). Wrap so TS sees the
			// snapshot-required call site as safe.
			const wrap = (s?: Snapshot) => { if (s) resolve(s); };
			this.pending.push({ type: expect, resolve: wrap, reject });
			try {
				this.send(msg);
			} catch (err) {
				// Failed to even post; back the pending entry out.
				const idx = this.pending.findIndex(p => p.resolve === wrap);
				if (idx !== -1) this.pending.splice(idx, 1);
				reject(err as Error);
			}
		});
	}

	private handleMessage = (ev: MessageEvent): void => {
		const msg = ev.data as WorkerMsg;
		if (msg.type === 'error') {
			const err = new Error(msg.message);
			if (msg.stack) err.stack = msg.stack;
			// Reject the next pending request and notify error listeners.
			const next = this.pending.shift();
			next?.reject(err);
			for (const cb of this.errorListeners) cb(err);
			return;
		}

		// `clusterReport` carries diagnostics, no snapshot; fan out to listeners.
		if (msg.type === 'clusterReport') {
			this._clusterReport = msg.report;
			for (const cb of this.clusterListeners) cb(msg.report);
			return;
		}

		// `shutdown_done` carries no snapshot; just clear local state and
		// resolve the head pending request.
		if (msg.type === 'shutdown_done') {
			this.latest = null;
			this.bootstrap = null;
			const head = this.pending[0];
			if (head && head.type === 'shutdown_done') {
				this.pending.shift();
				head.resolve();
			}
			return;
		}

		// Update latest snapshot and notify listeners.
		this.latest = msg.snapshot;
		if (msg.type === 'started') {
			this._gpuAvailable = msg.gpuAvailable;
			this._gpuActive = msg.gpuActive;
			this.bootstrap = msg.bootstrap;
			for (const cb of this.bootstrapListeners) cb(msg.bootstrap);
		}
		for (const cb of this.snapshotListeners) cb(msg.snapshot);

		// Resolve the head pending request if its expected type matches.
		// Snapshot streaming during `run` doesn't push pending entries, so
		// those skip this branch and only flow to subscribers.
		const head = this.pending[0];
		if (head && head.type === msg.type) {
			this.pending.shift();
			head.resolve(msg.snapshot);
		}
	};

	private handleWorkerError = (ev: ErrorEvent): void => {
		const err = new Error(ev.message || 'Worker error');
		const next = this.pending.shift();
		next?.reject(err);
		for (const cb of this.errorListeners) cb(err);
	};
}

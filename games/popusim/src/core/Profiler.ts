/**
 * Profiler — lightweight aggregate timing for the simulation hot paths.
 *
 * Usage:
 *   const t = profiler.start('Site.updateContact');
 *   ... do work ...
 *   t();   // stops the timer and adds the elapsed ms to the bucket.
 *
 * Or with the convenience wrapper:
 *   await profiler.measure('Site.updateContact', async () => { ... });
 *
 * Each label accumulates count + total ms + max ms across calls. `report()`
 * prints a console.table sorted by total ms descending, then resets — so a
 * "per-day report" is just `report()` at end-of-day.
 *
 * The profiler is a singleton because we instrument hot paths from many
 * files and don't want to thread an instance through every layer.
 *
 * Disabled by default (`enabled = false`) so production scenarios pay zero
 * cost. Flip via `profiler.enable()` / `profiler.disable()` from the worker
 * or browser console (`__profiler.enable()`).
 */

interface Bucket {
	count: number;
	totalMs: number;
	maxMs: number;
}

class Profiler {
	// Disabled by default — flip via the worker's `setProfiler` message
	// (or `__profiler.enable()` from the worker's console pane in DevTools).
	// The cost when disabled is one `if (!enabled)` branch per measure call.
	enabled: boolean = false;
	private buckets: Map<string, Bucket> = new Map();
	private dayStartMs: number = 0;

	enable(): void { this.enabled = true; }
	disable(): void { this.enabled = false; }
	isEnabled(): boolean { return this.enabled; }

	/** Start a timer; returns a stopper. Cheap when disabled (returns a no-op). */
	start(label: string): () => void {
		if (!this.enabled) return NOOP;
		const t0 = performance.now();
		return () => {
			const dt = performance.now() - t0;
			let b = this.buckets.get(label);
			if (!b) {
				b = { count: 0, totalMs: 0, maxMs: 0 };
				this.buckets.set(label, b);
			}
			b.count++;
			b.totalMs += dt;
			if (dt > b.maxMs) b.maxMs = dt;
		};
	}

	/** Wrap a sync function. */
	measure<T>(label: string, fn: () => T): T {
		const stop = this.start(label);
		try { return fn(); } finally { stop(); }
	}

	/** Wrap an async function. */
	async measureAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
		const stop = this.start(label);
		try { return await fn(); } finally { stop(); }
	}

	/** Mark the start of a day for percentage calculations. */
	beginDay(): void {
		if (!this.enabled) return;
		this.dayStartMs = performance.now();
	}

	/** Print a per-label breakdown sorted by total ms descending, then reset. */
	report(label: string = 'profiler'): void {
		if (!this.enabled || this.buckets.size === 0) return;
		const wallMs = this.dayStartMs > 0 ? performance.now() - this.dayStartMs : 0;
		const rows: { label: string; count: number; totalMs: string; avgMs: string; maxMs: string; pct: string }[] = [];
		const entries = [...this.buckets.entries()].sort((a, b) => b[1].totalMs - a[1].totalMs);
		for (const [k, b] of entries) {
			rows.push({
				label: k,
				count: b.count,
				totalMs: b.totalMs.toFixed(2),
				avgMs: (b.totalMs / b.count).toFixed(3),
				maxMs: b.maxMs.toFixed(2),
				pct: wallMs > 0 ? (b.totalMs / wallMs * 100).toFixed(1) + '%' : '—',
			});
		}
		console.log(`[${label}] wall=${wallMs.toFixed(2)}ms`);
		console.table(rows);
		this.buckets.clear();
		this.dayStartMs = 0;
	}
}

const NOOP = (): void => { };

export const profiler = new Profiler();

// Expose for browser-console toggling (matches the gpuDebug pattern).
const g = globalThis as { __profiler?: Profiler };
if (!g.__profiler) g.__profiler = profiler;

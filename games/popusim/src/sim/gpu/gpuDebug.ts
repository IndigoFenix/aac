/**
 * gpuDebug — opt-in diagnostic helpers for GPU vs CPU comparison.
 *
 * Both GPU batches (seekMod, applyShed) check `gpuDebugEnabled()` to decide
 * whether to also run the CPU reference path and log discrepancies. The
 * flag is on by default for the first `MAX_LOG_INVOCATIONS` dispatches per
 * batch, then auto-quiets. Re-enable from the browser console with
 * `__gpuDebug.reset()` or `__gpuDebug.enable()`.
 *
 * Designed to be cheap on the hot path once quieted (single counter check).
 */

const MAX_LOG_INVOCATIONS = 6;
const counters: Record<string, number> = {};
let forceEnabled = true;

export function gpuDebugShouldLog(label: string): boolean {
	if (!forceEnabled) return false;
	const c = counters[label] ?? 0;
	if (c >= MAX_LOG_INVOCATIONS) return false;
	counters[label] = c + 1;
	return true;
}

export function gpuDebugLog(label: string, ...args: unknown[]): void {
	console.log(`[gpu:${label}]`, ...args);
}

/** Compare two arrays elementwise, return summary string. */
export function gpuDebugCompare(
	gpu: Float32Array | Uint32Array,
	cpu: Float32Array | Uint32Array,
	tolerance = 1e-3,
): { equalCount: number; mismatchCount: number; maxAbsDiff: number; firstMismatch: number } {
	const n = Math.min(gpu.length, cpu.length);
	let equal = 0;
	let mismatch = 0;
	let maxDiff = 0;
	let firstMismatch = -1;
	for (let i = 0; i < n; i++) {
		const d = Math.abs(gpu[i] - cpu[i]);
		if (d <= tolerance) {
			equal++;
		} else {
			mismatch++;
			if (firstMismatch === -1) firstMismatch = i;
			if (d > maxDiff) maxDiff = d;
		}
	}
	return { equalCount: equal, mismatchCount: mismatch, maxAbsDiff: maxDiff, firstMismatch };
}

interface GpuDebugApi {
	enable: () => void;
	disable: () => void;
	reset: () => void;
	state: () => { forceEnabled: boolean; counters: Record<string, number> };
}

const api: GpuDebugApi = {
	enable: () => { forceEnabled = true; },
	disable: () => { forceEnabled = false; },
	reset: () => {
		for (const k of Object.keys(counters)) counters[k] = 0;
		forceEnabled = true;
	},
	state: () => ({ forceEnabled, counters: { ...counters } }),
};

const g = globalThis as { __gpuDebug?: GpuDebugApi };
if (!g.__gpuDebug) g.__gpuDebug = api;

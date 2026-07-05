/**
 * shedAmountBatch — collect/dispatch/apply pattern for shed amount math.
 *
 * `Population.updateTransmission` no longer calls `generateRandom` inline.
 * Instead it pushes `ShedItem`s onto a per-Site batch. After all populations
 * for a phase have collected, `Site.updateTransmission` calls
 * `runShedAmountBatch` which:
 *   - computes all amounts via the GPU kernel if available, else CPU.
 *   - invokes each item's `apply` callback with the computed amount.
 *
 * This is the only path that consumes shed-amount RNG, so swapping CPU↔GPU
 * is a one-line decision in `Site.updateTransmission`.
 */

import { cpuShedAmount } from './cpuShedAmount';
import type { ShedAmountKernel } from './shedAmountKernel';
import type { GpuPopState } from './GpuPopState';
import { profiler } from '../../core/Profiler';
import { Shed } from '../../game/simulation/Shed';

/** Dispatch tag — set on every ShedItem so the batch driver knows which
 * code path to take when consuming the computed shed amount. */
export const SHED_KIND_TRANSMIT = 0;
export const SHED_KIND_PROGRESS = 1;
export const SHED_KIND_PRODUCE = 2;

interface SynTransmitLike {
	key: string;
	vectors: unknown[];
	vector_keys: string[];
	traits: unknown[];
	trait_keys: string[];
	cures: unknown[];
	cure_keys: string[];
	seek: unknown[];
	precise: boolean;
	ranged?: number;
	relevant_clusters: unknown;
}

interface SiteLike {
	/** Routes-aware deposit: exports the transmit's `ranged` share along
	 * the site's routes, then addSheds the local remainder. */
	depositTransmitShed(src: SynTransmitLike, amount: number): void;
}

interface PopulationLike {
	progress: Shed[];
}

interface StockpileLike {
	addImpactValue(amount: number): void;
}

/**
 * Batch entry describing one (population, transmit) shed-amount draw.
 *
 * Pre-Stage-N (closure removal) we stored an `apply: (amount) => void`
 * closure here. Each phase produced ~175k of those closures plus their
 * captured environments — at ~100 bytes per closure that's >15 MB of GC
 * pressure per phase, and `Site.updateTransmission/gatherPopShed` was
 * dominated by closure allocation rather than the simulation work itself.
 *
 * Replacing the closure with a kind tag + plain references means
 * `gatherPopShed` only allocates the small object literal; the dispatch
 * logic lives once in `runShedAmountBatch` instead of being closed-over
 * per item.
 */
export interface ShedItem {
	popId: number;
	txKindId: number;
	popCount: number;
	value: number;
	sd: number;
	/** SHED_KIND_* — picks which branch in the dispatch loop runs. */
	kind: number;
	/** popmult multiplier; 1 when popmult is unset. Only consulted by
	 * TRANSMIT to scale the amount before site.addShed. */
	popMul: number;
	/** SynTransmit-shaped object for TRANSMIT and PROGRESS kinds. Unused for
	 * PRODUCE (the kind dispatches directly on `target`). */
	source: SynTransmitLike | null;
	/** Site for TRANSMIT, Population for PROGRESS, Stockpile for PRODUCE. */
	target: SiteLike | PopulationLike | StockpileLike;
}

export interface ShedBatchInputs {
	items: ShedItem[];
	seed: number;
	day: number;
	phase: number;
	gpuKernel: ShedAmountKernel | null;
	/** Carries the pop_count GPU buffer used by the GPU kernel. The CPU
	 * path ignores this and reads `ShedItem.popCount` directly. */
	gpuPopState: GpuPopState | null;
}

/**
 * Run the batch of shed-amount items. Computes amounts (CPU or GPU),
 * then invokes each item's `apply` with its result. Items with
 * non-finite or non-positive amounts are skipped — `apply` is not called
 * (matches the legacy `if (amount <= 0) continue` guard).
 */
export async function runShedAmountBatch(b: ShedBatchInputs): Promise<void> {
	const n = b.items.length;
	if (n === 0) return;

	let amounts: Float32Array | number[];
	if (b.gpuKernel && b.gpuPopState && b.gpuPopState.popCountBuffer) {
		const stopGpu = profiler.start('shedAmount/gpu-dispatch');
		// pop counts come from the persistent GpuPopState buffer; we only
		// upload the per-pair scalars here.
		const values = new Float32Array(n);
		const sds = new Float32Array(n);
		const popIds = new Uint32Array(n);
		const txKindIds = new Uint32Array(n);
		for (let i = 0; i < n; i++) {
			const it = b.items[i];
			values[i] = it.value;
			sds[i] = it.sd;
			popIds[i] = it.popId >>> 0;
			txKindIds[i] = it.txKindId >>> 0;
		}
		amounts = await b.gpuKernel.run({
			popCountBuffer: b.gpuPopState.popCountBuffer,
			values, sds, popIds, txKindIds,
			seed: b.seed, day: b.day, phase: b.phase,
		});
		stopGpu();
	} else {
		const stopCpu = profiler.start('shedAmount/cpu-loop');
		amounts = new Array<number>(n);
		for (let i = 0; i < n; i++) {
			const it = b.items[i];
			amounts[i] = cpuShedAmount(
				it.popCount, it.value, it.sd,
				b.seed, b.day, b.phase, it.popId, it.txKindId,
			);
		}
		stopCpu();
	}

	const stopApply = profiler.start('shedAmount/apply-callbacks');
	for (let i = 0; i < n; i++) {
		const a = amounts[i];
		if (!isFinite(a) || a <= 0) continue;
		const item = b.items[i];
		switch (item.kind) {
			case SHED_KIND_TRANSMIT: {
				const finalAmount = a * item.popMul;
				if (finalAmount <= 0 || isNaN(finalAmount)) continue;
				(item.target as SiteLike).depositTransmitShed(item.source!, finalAmount);
				break;
			}
			case SHED_KIND_PROGRESS: {
				const src = item.source!;
				const pop = item.target as PopulationLike;
				pop.progress.push(new Shed(
					pop as never, src.key, a,
					src.vectors as never, src.vector_keys,
					src.traits as never, src.trait_keys,
					src.cures as never, src.cure_keys,
					src.seek as never, src.precise,
					src.relevant_clusters as never,
				));
				break;
			}
			case SHED_KIND_PRODUCE: {
				(item.target as StockpileLike).addImpactValue(a);
				break;
			}
		}
	}
	stopApply();
}

/**
 * seekModBatch — pack/dispatch/unpack helper for batched seek_mod compute.
 *
 * Used by `Site.updateContact`. Caller provides:
 *   - the shed list
 *   - per-pair shed index + popId (parallel typed arrays)
 *   - the world's GpuPopState (which owns the pop_mask GPU buffer + a CPU
 *     mirror of every population's primary-syndrome mask)
 *
 * The helper:
 *   1. Asks each shed to populate its seek_has_masks / seek_not_masks /
 *      seek_mults via `Shed.ensureSeekMasks(world)`.
 *   2. Builds the flattened per-shed seek tables.
 *   3. Dispatches `SeekModKernel` if a kernel is supplied; otherwise
 *      computes the seek_mods on CPU via the same bitmask logic, reading
 *      masks directly from `world.populations_by_id`.
 *
 * Pre-Phase-1 we passed a `pairSynMask: Uint32Array[]` of `n` references
 * to syndrome trait_masks; the GPU dispatch then re-copied those into a
 * flat `n × MASK_WORDS` Uint32Array per phase. Phase 1 collapses both —
 * the GPU reads `pop_mask[popIds[i]]` directly from GpuPopState's
 * persistent buffer.
 *
 * Both paths produce identical results — there's no float-precision
 * concern here because seek_mod is just a product of declared `mult`
 * values (no transcendental math).
 *
 * Output: Float32Array of length pairCount, with seek_mod[i] for pair i.
 */

import type { Shed } from '../../game/simulation/Shed';
import type { SeekModKernel } from './seekModKernel';
import type { GpuPopState } from './GpuPopState';
import { MASK_WORDS } from './traitMask';
import { gpuDebugShouldLog, gpuDebugLog, gpuDebugCompare } from './gpuDebug';
import { profiler } from '../../core/Profiler';

interface ShedRuntime {
	seek: { length: number };
	seek_has_masks: Uint32Array;
	seek_not_masks: Uint32Array;
	seek_mults: Float32Array;
	ensureSeekMasks(world: TraitWorldLookup): void;
}

interface SyndromeRuntime {
	trait_mask: Uint32Array;
}

interface PopulationLike {
	id: number;
	syndrome: SyndromeRuntime;
}

interface TraitWorldLookup {
	traits_kv: Record<string, { index: number } | undefined>;
}

export interface SeekModBatchInputs {
	world: TraitWorldLookup;
	/** Populations indexed by Population.id. The CPU fallback path reads
	 * `populations[popIds[i]].syndrome.trait_mask`; the GPU path ignores
	 * this and reads from `gpuPopState.popMaskBuffer` instead. */
	populations: ReadonlyArray<PopulationLike | null | undefined>;
	/** GpuPopState whose popMaskBuffer is up-to-date for this phase. */
	gpuPopState: GpuPopState | null;
	sheds: Shed[];
	/** Number of populated entries in the pair arrays. */
	pairCount: number;
	/** Per-pair shed index. Length >= pairCount. */
	pairShedIdx: Uint32Array;
	/** Per-pair Population id (index into `populations` and into the
	 * world-wide `pop_mask` buffer). Length >= pairCount. */
	pairPopId: Uint32Array;
	gpuKernel: SeekModKernel | null;
}

/** Run the batch. Returns a Float32Array indexed by pair (length pairCount). */
export async function runSeekModBatch(b: SeekModBatchInputs): Promise<Float32Array> {
	const n = b.pairCount;
	if (n === 0) return new Float32Array(0);

	// Make sure each shed has its bitmasks built.
	for (const shed of b.sheds) {
		(shed as unknown as ShedRuntime).ensureSeekMasks(b.world);
	}

	if (b.gpuKernel && b.gpuPopState && b.gpuPopState.popMaskBuffer) {
		const stopGpu = profiler.start('seekMod/gpu-dispatch');
		const gpu = await runOnGpu(b);
		stopGpu();
		if (gpuDebugShouldLog('seekMod')) {
			const cpu = runOnCpu(b);
			const cmp = gpuDebugCompare(gpu, cpu, 1e-4);
			let nonzeroGpu = 0, nonzeroCpu = 0;
			for (let i = 0; i < gpu.length; i++) {
				if (gpu[i] !== 0) nonzeroGpu++;
				if (cpu[i] !== 0) nonzeroCpu++;
			}
			gpuDebugLog(
				'seekMod',
				`pairs=${n}, sheds=${b.sheds.length}, nonzeroGpu=${nonzeroGpu}, nonzeroCpu=${nonzeroCpu}`,
				cmp,
			);
			const sample = Math.min(5, n);
			for (let i = 0; i < sample; i++) {
				const sh = b.sheds[b.pairShedIdx[i]] as unknown as { key?: string };
				const pop = b.populations[b.pairPopId[i]];
				const syn = pop?.syndrome.trait_mask;
				gpuDebugLog(
					'seekMod[pair]',
					`i=${i} shed=${sh.key ?? '?'} popId=${b.pairPopId[i]} ` +
					`syn=[${syn ? Array.from(syn).map(w => '0x' + (w >>> 0).toString(16)).join(',') : '?'}] ` +
					`gpu=${gpu[i].toFixed(4)} cpu=${cpu[i].toFixed(4)}`,
				);
			}
		}
		return gpu;
	}
	const stopCpu = profiler.start('seekMod/cpu-loop');
	const out = runOnCpu(b);
	stopCpu();
	return out;
}

async function runOnGpu(b: SeekModBatchInputs): Promise<Float32Array> {
	const n = b.pairCount;
	const nSheds = b.sheds.length;

	// Flatten per-shed seek tables.
	const seekOffsets = new Uint32Array(nSheds);
	const seekCounts = new Uint32Array(nSheds);
	let total = 0;
	for (let s = 0; s < nSheds; s++) {
		const sh = b.sheds[s] as unknown as ShedRuntime;
		seekOffsets[s] = total;
		seekCounts[s] = sh.seek.length;
		total += sh.seek.length;
	}
	const seekHas = new Uint32Array(Math.max(MASK_WORDS, total * MASK_WORDS));
	const seekNot = new Uint32Array(Math.max(MASK_WORDS, total * MASK_WORDS));
	const seekMults = new Float32Array(Math.max(1, total));
	for (let s = 0; s < nSheds; s++) {
		const sh = b.sheds[s] as unknown as ShedRuntime;
		const off = seekOffsets[s];
		const cnt = seekCounts[s];
		for (let k = 0; k < cnt; k++) {
			const dst = (off + k) * MASK_WORDS;
			const src = k * MASK_WORDS;
			for (let w = 0; w < MASK_WORDS; w++) {
				seekHas[dst + w] = sh.seek_has_masks[src + w];
				seekNot[dst + w] = sh.seek_not_masks[src + w];
			}
			seekMults[off + k] = sh.seek_mults[k];
		}
	}

	const shedIndex = b.pairShedIdx.subarray(0, n);
	const popIds = b.pairPopId.subarray(0, n);

	return b.gpuKernel!.run({
		popMaskBuffer: b.gpuPopState!.popMaskBuffer!,
		popIds,
		shedIndex,
		seekOffsets, seekCounts,
		seekHas, seekNot, seekMults,
	});
}

function runOnCpu(b: SeekModBatchInputs): Float32Array {
	const n = b.pairCount;
	const out = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		const sh = b.sheds[b.pairShedIdx[i]] as unknown as ShedRuntime;
		const cnt = sh.seek.length;
		if (cnt === 0) { out[i] = 1; continue; }

		const pop = b.populations[b.pairPopId[i]];
		const syn = pop ? pop.syndrome.trait_mask : null;
		if (syn === null) { out[i] = 0; continue; }

		let v = 1;
		for (let k = 0; k < cnt; k++) {
			const seekOff = k * MASK_WORDS;
			let apply = false;
			for (let w = 0; w < MASK_WORDS; w++) {
				if ((sh.seek_has_masks[seekOff + w] & syn[w]) !== 0) { apply = true; break; }
			}
			if (!apply) {
				for (let w = 0; w < MASK_WORDS; w++) {
					if ((sh.seek_not_masks[seekOff + w] & ~syn[w]) !== 0) { apply = true; break; }
				}
			}
			if (apply) v *= sh.seek_mults[k];
		}
		out[i] = v;
	}
	return out;
}

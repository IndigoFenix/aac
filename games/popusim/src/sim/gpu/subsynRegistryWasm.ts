/**
 * subsynRegistryWasm — JS wrapper around the AssemblyScript-compiled WASM
 * module at `wasm/build/subsynRegistry.wasm`.
 *
 * Three batched entry points (all running entirely in WASM linear memory):
 *
 *   - `processPostPass(n)` — GPU path. Caller has already populated
 *     `viewHits` + `viewTargetMasks` (from kernel readback) and
 *     `viewSourceIds` + `viewPopIds`. WASM resolves ids and emits tuples.
 *
 *   - `cpuApplyAndPostPass(n)` — CPU-only path. Caller populates
 *     `viewVectorCounts` + `viewModPairId` + `viewPrecise` +
 *     `viewSourceIds` + `viewPopIds`, plus the mod tables and pop state.
 *     WASM does dispatch math + target-mask compute + id resolution +
 *     tuple emission in a single pass, never crossing FFI inside the
 *     loop.
 *
 *   - Per-call `getOrInsertId` / `getMaskAtId` / `seed` for non-batched
 *     callers (initial scenario load, lazy materialization, tests).
 *
 * Buffer layout: every typed array used by the batched paths lives in WASM
 * linear memory at a fixed `dataStart` pointer. JS gets views over
 * `memory.buffer` at those pointers and writes/reads in place. When AS
 * grows linear memory (geometric on capacity miss), `memory.buffer` is
 * replaced and our views detach; `ensure*` returns 1 to signal a refresh.
 */

import { MASK_WORDS } from './traitMask';

interface WasmExports {
	memory: WebAssembly.Memory;
	reset(): void;
	seed(id: number, m0: number, m1: number, m2: number, m3: number): void;
	getOrInsertId(m0: number, m1: number, m2: number, m3: number): number;
	getCounter(): number;
	getMaskWord(id: number, word: number): number;
	ensurePairCapacity(n: number): number;
	ensureModCapacity(n: number): number;
	ensurePopCapacity(n: number): number;
	getPairCapacity(): number;
	getModCapacity(): number;
	getPopCapacity(): number;
	inHitsPtr(): number;
	inTargetMasksPtr(): number;
	inSourceIdsPtr(): number;
	inPopIdsPtr(): number;
	inVectorCountsPtr(): number;
	inModPairIdPtr(): number;
	inPrecisePtr(): number;
	outPopIdsPtr(): number;
	outSourceIdsPtr(): number;
	outTargetIdsPtr(): number;
	outAmountsPtr(): number;
	modMultipliersPtr(): number;
	modApplyMaskPtr(): number;
	modRemoveMaskPtr(): number;
	popCountsPtr(): number;
	popMasksPtr(): number;
	processPostPass(n: number, seed: number, day: number, phase: number): number;
	cpuApplyAndPostPass(n: number, seed: number, day: number, phase: number): number;
}

let modulePromise: Promise<WasmExports> | null = null;

async function loadWasm(): Promise<WasmExports> {
	// eslint-disable-next-line @typescript-eslint/ban-ts-comment
	// @ts-ignore — generated module's emitted shape has no .d.ts at this path.
	const mod = await import('../../../wasm/build/subsynRegistry.js');
	return mod as unknown as WasmExports;
}

export async function getSubsynRegistry(): Promise<SubsynRegistryWasm> {
	if (modulePromise === null) modulePromise = loadWasm();
	return new SubsynRegistryWasm(await modulePromise);
}

/** Pair-level views in WASM memory. The caller writes inputs and reads
 * outputs through these `Uint32Array` / `Float32Array` references. */
export interface PairViews {
	hits: Float32Array;
	targetMasks: Uint32Array;
	sourceIds: Uint32Array;
	popIds: Uint32Array;
	vectorCounts: Float32Array;
	modPairId: Uint32Array;
	precise: Uint32Array;
}
/** Mod-table views — caller fills these in the pre-pass. */
export interface ModViews {
	multipliers: Float32Array;
	applyMask: Uint32Array;
	removeMask: Uint32Array;
}
/** Per-pop state views — caller mirrors GpuPopState into these once per
 * phase. */
export interface PopViews {
	counts: Uint32Array;
	masks: Uint32Array;
}

export class SubsynRegistryWasm {
	private readonly w: WasmExports;
	private readonly scratch: Uint32Array = new Uint32Array(MASK_WORDS);

	private bufferRef: ArrayBuffer | null = null;
	private cachedPair: PairViews | null = null;
	private cachedMod: ModViews | null = null;
	private cachedPop: PopViews | null = null;

	constructor(exports: WasmExports) { this.w = exports; }

	reset(): void { this.w.reset(); this.bufferRef = null; }

	seed(id: number, mask: Uint32Array, off: number): void {
		this.w.seed(id, mask[off], mask[off + 1], mask[off + 2], mask[off + 3]);
	}

	getOrInsertId(mask: Uint32Array, off: number): number {
		return this.w.getOrInsertId(mask[off], mask[off + 1], mask[off + 2], mask[off + 3]);
	}

	getCounter(): number { return this.w.getCounter(); }

	getMaskAtId(id: number, out: Uint32Array, outOff: number): void {
		out[outOff] = this.w.getMaskWord(id, 0);
		out[outOff + 1] = this.w.getMaskWord(id, 1);
		out[outOff + 2] = this.w.getMaskWord(id, 2);
		out[outOff + 3] = this.w.getMaskWord(id, 3);
	}

	get tempMask(): Uint32Array { return this.scratch; }

	/**
	 * Ensure all three buffer kinds have enough capacity, then refresh the
	 * cached views once. Use this when you need pair + mod + (optional)
	 * pop views in the same call — calling them individually risks a
	 * later `ensure*` triggering a memory grow that detaches earlier views
	 * we already grabbed.
	 */
	ensureCapacities(n: number, nMod: number, popMax?: number): {
		pair: PairViews;
		mod: ModViews;
		pop: PopViews;
	} {
		let grew = false;
		const pairGrew = this.w.ensurePairCapacity(n);
		if (pairGrew < 0) throw new Error(`pair capacity exceeded: ${n}`);
		if (pairGrew === 1) grew = true;
		const modGrew = this.w.ensureModCapacity(nMod);
		if (modGrew < 0) throw new Error(`mod capacity exceeded: ${nMod}`);
		if (modGrew === 1) grew = true;
		if (popMax !== undefined) {
			const popGrew = this.w.ensurePopCapacity(popMax);
			if (popGrew < 0) throw new Error(`pop capacity exceeded: ${popMax}`);
			if (popGrew === 1) grew = true;
		}
		this.refreshIfNeeded(grew);
		return {
			pair: this.cachedPair!,
			mod: this.cachedMod!,
			pop: this.cachedPop!,
		};
	}

	/** Convenience wrappers that go through `ensureCapacities` so callers
	 * that only need one view kind don't have to worry about ordering. */
	ensurePairViews(n: number): PairViews {
		return this.ensureCapacities(n, 0).pair;
	}
	ensureModViews(nMod: number): ModViews {
		return this.ensureCapacities(0, nMod).mod;
	}
	ensurePopViews(maxPopId: number): PopViews {
		return this.ensureCapacities(0, 0, maxPopId).pop;
	}

	/** Run the GPU-path post-pass over the first `n` populated entries.
	 * `seed/day/phase` drive the deterministic stochastic-rounding step that
	 * converts float `hits` to integer-valued `outAmounts` in place — so JS
	 * can write the output straight into the delta and `applyDeltaShift`
	 * sees frac == 0, skipping the rng path entirely. */
	runPostPass(n: number, seed: number, day: number, phase: number): {
		count: number;
		outPopIds: Uint32Array;
		outSourceIds: Uint32Array;
		outTargetIds: Uint32Array;
		outAmounts: Float32Array;
	} {
		const outN = this.w.processPostPass(n, seed >>> 0, day >>> 0, phase >>> 0);
		return this.outViews(outN);
	}

	/** Run the CPU-path full pipeline (dispatch + post-pass) in one WASM
	 * call. All inputs must be pre-written to the pair / mod / pop views.
	 * `seed/day/phase` drive the stochastic-round step. */
	runCpuApplyAndPostPass(n: number, seed: number, day: number, phase: number): {
		count: number;
		outPopIds: Uint32Array;
		outSourceIds: Uint32Array;
		outTargetIds: Uint32Array;
		outAmounts: Float32Array;
	} {
		const outN = this.w.cpuApplyAndPostPass(n, seed >>> 0, day >>> 0, phase >>> 0);
		return this.outViews(outN);
	}

	private outViews(outN: number) {
		const buf = this.w.memory.buffer;
		// Output views always read from `cachedPair`'s underlying buffer;
		// if memory grew we'd have already refreshed during ensure*.
		if (this.cachedPair === null || this.bufferRef !== buf) this.refreshIfNeeded(true);
		const p = this.cachedPair!;
		// Output buffers share the pool's pair capacity but have their own
		// pointers; reconstruct typed-array subviews of length `outN`.
		const cap = this.w.getPairCapacity();
		const outPopIds = new Uint32Array(buf, this.w.outPopIdsPtr(), cap).subarray(0, outN);
		const outSourceIds = new Uint32Array(buf, this.w.outSourceIdsPtr(), cap).subarray(0, outN);
		const outTargetIds = new Uint32Array(buf, this.w.outTargetIdsPtr(), cap).subarray(0, outN);
		const outAmounts = new Float32Array(buf, this.w.outAmountsPtr(), cap).subarray(0, outN);
		void p;
		return { count: outN, outPopIds, outSourceIds, outTargetIds, outAmounts };
	}

	private refreshIfNeeded(grew: boolean): void {
		const buf = this.w.memory.buffer;
		if (!grew && this.bufferRef === buf && this.cachedPair !== null) return;
		const pairCap = this.w.getPairCapacity();
		const modCap = this.w.getModCapacity();
		const popCap = this.w.getPopCapacity();
		this.cachedPair = {
			hits: new Float32Array(buf, this.w.inHitsPtr(), pairCap),
			targetMasks: new Uint32Array(buf, this.w.inTargetMasksPtr(), pairCap * MASK_WORDS),
			sourceIds: new Uint32Array(buf, this.w.inSourceIdsPtr(), pairCap),
			popIds: new Uint32Array(buf, this.w.inPopIdsPtr(), pairCap),
			vectorCounts: new Float32Array(buf, this.w.inVectorCountsPtr(), pairCap),
			modPairId: new Uint32Array(buf, this.w.inModPairIdPtr(), pairCap),
			precise: new Uint32Array(buf, this.w.inPrecisePtr(), pairCap),
		};
		this.cachedMod = {
			multipliers: new Float32Array(buf, this.w.modMultipliersPtr(), modCap),
			applyMask: new Uint32Array(buf, this.w.modApplyMaskPtr(), modCap * MASK_WORDS),
			removeMask: new Uint32Array(buf, this.w.modRemoveMaskPtr(), modCap * MASK_WORDS),
		};
		this.cachedPop = {
			counts: new Uint32Array(buf, this.w.popCountsPtr(), popCap),
			masks: new Uint32Array(buf, this.w.popMasksPtr(), popCap * MASK_WORDS),
		};
		this.bufferRef = buf;
	}
}
